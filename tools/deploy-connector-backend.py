#!/usr/bin/env python3
"""Run as root on the portal host with a locally uploaded release tarball.

Back up before migration, deploy with invitations disabled, and preserve a rollback
snapshot. The bundle must contain only main.mjs, main.mjs.map, migrations/, web/.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import time
from datetime import datetime, timezone
from urllib.request import urlopen
from urllib.error import HTTPError

APP = Path('/opt/forkflow-portal')
DB = Path('/var/lib/forkflow-portal/licensing.db')
ENV = Path('/etc/forkflow-portal/env')
SERVICE = 'forkflow-portal'

def service(action):
    subprocess.run(['systemctl', action, SERVICE], check=True)

def unpack(bundle, destination):
    with tarfile.open(bundle) as archive:
        for member in archive.getmembers():
            parts = Path(member.name).parts
            if not parts or parts[0] not in ('main.mjs', 'main.mjs.map', 'migrations', 'web') or '..' in parts or Path(member.name).is_absolute() or not (member.isfile() or member.isdir()):
                raise ValueError('Unsafe release archive member')
            target = destination.joinpath(*parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open('wb') as out:
                    shutil.copyfileobj(source, out)
                target.chmod(0o644)

def deploy(bundle, digest):
    if os.geteuid() != 0:
        raise PermissionError('Run with sudo on the portal host')
    if hashlib.sha256(bundle.read_bytes()).hexdigest() != digest:
        raise ValueError('Release bundle hash mismatch')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = Path('/var/backups/forkflow-portal') / ('connector-' + stamp)
    backup.mkdir(parents=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix='connector-deploy-') as scratch:
        source = Path(scratch)
        unpack(bundle, source)
        if not (source/'migrations/0009_connector.sql').is_file() or not (source/'web/portal/index.html').is_file():
            raise ValueError('Incomplete connector release')
        service('stop')
        snapshot_ready = False
        try:
            shutil.copy2(ENV, backup/'env')
            with tarfile.open(backup/'application.tar.gz', 'w:gz') as archive:
                archive.add(APP, arcname='application')
            with sqlite3.connect(DB) as old, sqlite3.connect(backup/'licensing.db') as snapshot:
                old.backup(snapshot)
                expected = {table: old.execute('SELECT COUNT(*) FROM '+table).fetchone()[0] for table in ('support_chats','support_chat_messages','remote_sessions')}
            snapshot_ready = True
            lines = [line for line in ENV.read_text().splitlines() if not line.startswith('CONNECTOR_ENABLED=')]
            ENV.write_text('\n'.join(lines + ['CONNECTOR_ENABLED=0']) + '\n')
            for name in ('main.mjs', 'main.mjs.map', 'migrations', 'web'):
                dest = APP/name
                if (source/name).is_dir():
                    if dest.exists(): shutil.rmtree(dest)
                    shutil.copytree(source/name, dest)
                elif (source/name).exists(): shutil.copy2(source/name, dest)
            service('start')
            for attempt in range(30):
                try:
                    with urlopen('http://127.0.0.1:8787/portal/', timeout=2) as response:
                        if response.status == 200: break
                except OSError: time.sleep(1)
            else: raise RuntimeError('Portal health check failed')
            try:
                urlopen('http://127.0.0.1:8787/support/connector-runtime/latest.json', timeout=5)
                raise RuntimeError('Connector unexpectedly enabled')
            except HTTPError as error:
                if error.code != 503: raise
            with sqlite3.connect(DB) as current:
                assert current.execute("SELECT 1 FROM _migrations WHERE name='0009_connector.sql'").fetchone()
                assert not current.execute('PRAGMA foreign_key_check').fetchall()
                assert current.execute('PRAGMA integrity_check').fetchone() == ('ok',)
                counts = {table: current.execute('SELECT COUNT(*) FROM '+table).fetchone()[0] for table in ('support_chats','support_chat_messages','remote_sessions')}
                assert counts == expected, 'Existing support records changed during migration'
            print(json.dumps({'backup':str(backup),'connectorEnabled':False,'migration':'0009_connector.sql','preservedCounts':counts}))
        except BaseException:
            service('stop')
            if snapshot_ready:
                # The service is stopped; discard only WALs from the failed deployment.
                for suffix in ('-wal','-shm'): Path(str(DB)+suffix).unlink(missing_ok=True)
                shutil.copy2(backup/'licensing.db', DB)
                shutil.copy2(backup/'env', ENV)
                with tarfile.open(backup/'application.tar.gz') as archive:
                    archive.extractall(source/'rollback')
                shutil.rmtree(APP)
                shutil.copytree(source/'rollback/application', APP)
            service('start')
            raise

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--bundle',type=Path,required=True)
    parser.add_argument('--sha256',required=True)
    args=parser.parse_args()
    deploy(args.bundle,args.sha256)
