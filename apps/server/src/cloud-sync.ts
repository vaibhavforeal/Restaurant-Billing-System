import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { Bootstrap, CommandResult, ManagementCommand, type OutletStatus } from '@forkflow/contracts';
import { atomicJson } from './backups.js';
import { CloudJournal } from './cloud-journal.js';
import { applyCommand } from './cloud-commands.js';
import { CloudStorageJobs } from './cloud-storage.js';

const Pairing = z.object({ outletId: z.string().min(1), installationId: z.string().min(1), credential: z.string().min(1), epoch: z.string().min(1) });
const Binding = Pairing.extend({ cloudUrl: z.string().url(), generation: z.string() });
type Binding = z.infer<typeof Binding>;
export interface CloudOptions { dataDir: string; installationId: string; generation: string; fetch?: typeof fetch; allowLoopback?: boolean; serviceVersion?: string; enableStorage?: boolean }
export class CloudSync {
  private binding: Binding | null = null;
  private state: OutletStatus['state'] = 'not_paired';
  private lastError: string | null = null;
  private lastContact: number | null = null;
  private pending: Promise<void> | null = null;
  private stopped = false;
  private failures = 0;
  private pairing = false;
  private readonly storage: CloudStorageJobs | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly controller = new AbortController();
  constructor(readonly app: FastifyInstance, readonly journal: CloudJournal, readonly options: CloudOptions) {
    this.storage = options.enableStorage ? new CloudStorageJobs(app.db, options.dataDir, journal, (path, body) => this.request(path, body), options.fetch ?? fetch) : undefined;
    const path = join(options.dataDir, 'cloud-binding.json');
    if (existsSync(path)) {
      this.binding = Binding.parse(JSON.parse(readFileSync(path, 'utf8')));
      if (this.binding.generation !== options.generation) throw new Error('Cloud recovery reconciliation required before accepting new bills. Restore the latest verified snapshot and replay the cloud journal.');
      if (this.binding.installationId !== options.installationId) throw new Error('Cloud pairing belongs to another installation');
      this.checkUrl(this.binding.cloudUrl);
      journal.bind(this.binding.outletId, this.binding.installationId, this.binding.epoch);
      this.state = 'offline';
    }
  }
  private checkUrl(value: string): string {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use the cloud server origin without credentials or a path');
    if (url.protocol !== 'https:' && !(this.options.allowLoopback && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Cloud pairing requires HTTPS');
    return url.origin;
  }
  async pair(cloudUrl: string, code: string) {
    if (this.pairing) throw new Error('Another pairing request is already in progress');
    if (this.binding) throw new Error('This outlet is already paired; assisted retirement is required');
    this.pairing = true;
    try {
    const origin = this.checkUrl(cloudUrl);
    const response = await (this.options.fetch ?? fetch)(`${origin}/v1/outlets/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, installationId: this.options.installationId }), signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (!response.ok) throw new Error('Pairing code was rejected. Ask the owner for a new code.');
    const paired = Pairing.parse(await response.json());
    if (paired.installationId !== this.options.installationId) throw new Error('Pairing returned a different installation');
    const binding = { ...paired, cloudUrl: origin, generation: this.options.generation };
    this.app.db.transaction(() => {
      this.journal.bind(paired.outletId, paired.installationId, paired.epoch);
      atomicJson(join(this.options.dataDir, 'cloud-binding.json'), binding);
    })();
    this.binding = binding; this.state = 'offline';
    } finally { this.pairing = false; }
  }
  status(): OutletStatus {
    const state = this.journal.state();
    return { state: this.state, outletId: this.binding?.outletId ?? null, lastContact: this.lastContact, acknowledgedSequence: state.acknowledged, pendingUploads: state.sequence - state.acknowledged, initialSyncComplete: state.bootstrapped === 1, lastError: this.lastError, serviceVersion: this.options.serviceVersion ?? 'development' };
  }
  private async request(path: string, body?: unknown): Promise<unknown> {
    if (!this.binding) throw new Error('Outlet is not paired');
    const response = await (this.options.fetch ?? fetch)(`${this.binding.cloudUrl}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${this.binding.credential}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15_000)]), redirect: 'error' });
    if (!response.ok) {
      if ([400, 401, 403, 409, 422].includes(response.status)) { this.state = 'error'; throw new Error(`Cloud rejected synchronization (${response.status}); review outlet identity, journal sequence and application version.`); }
      throw new Error(`Cloud unavailable (${response.status})`);
    }
    return response.json();
  }
  tick(): Promise<void> {
    if (!this.pending) this.pending = this.synchronize().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async synchronize() {
    if (!this.binding || this.stopped) return;
    try {
      if (!this.journal.state().bootstrapped) {
        const path=join(this.options.dataDir,'cloud-bootstrap.json');
        const snapshot=existsSync(path)?Bootstrap.parse(JSON.parse(readFileSync(path,'utf8'))):this.journal.snapshot();
        if(snapshot.outletId!==this.binding.outletId||snapshot.installationId!==this.binding.installationId||snapshot.epoch!==this.binding.epoch)throw new Error('Saved initial synchronization belongs to another outlet');
        if(!existsSync(path))atomicJson(path,snapshot);
        const response = z.object({ acknowledgedSequence: z.literal(snapshot.sequence) }).parse(await this.request('/v1/sync/bootstrap', snapshot));
        this.journal.acknowledge(response.acknowledgedSequence, true);
        try {unlinkSync(path);} catch { /* acknowledged state makes an old staging file inert */ }
      }
      const events = this.journal.pending(100);
      if (events.length) {
        const response = z.object({ acknowledgedSequence: z.literal(events.at(-1)!.sequence) }).parse(await this.request('/v1/sync/push', { events }));
        this.journal.acknowledge(response.acknowledgedSequence);
      }
      const pendingResults = this.app.db.prepare('SELECT result_json FROM cloud_command_results WHERE acknowledged=0').all() as Array<{ result_json: string }>;
      if (pendingResults.length) {
        const results = pendingResults.map(row => CommandResult.parse(JSON.parse(row.result_json)));
        await this.request('/v1/sync/commands', { results });
        this.app.db.transaction(() => { for (const result of results) this.app.db.prepare('UPDATE cloud_command_results SET acknowledged=1 WHERE id=?').run(result.id); })();
      }
      const { commands } = z.object({ commands: z.array(ManagementCommand).max(100) }).parse(await this.request('/v1/sync/commands'));
      for (const command of commands) applyCommand(this.app, this.journal, command);
      this.state = 'connected'; this.lastContact = Date.now(); this.lastError = null; this.failures = 0;
      void this.storage?.run();
    } catch (error) {
      this.failures++;
      if (this.state !== 'error') this.state = error instanceof z.ZodError ? 'error' : 'offline';
      this.lastError = error instanceof z.ZodError ? 'Cloud protocol or acknowledgement did not match this outlet. No records were discarded.' : error instanceof Error ? error.message : 'Synchronization failed';
    }
  }
  start() {
    const cycle = async () => { await this.tick(); if (!this.stopped) { this.timer = setTimeout(() => { void cycle(); }, this.failures ? Math.min(60_000, 5000 * 2 ** Math.min(this.failures, 4)) : 5000); this.timer.unref(); } };
    void cycle();
  }
  storageStatus() { return this.storage?.status() ?? { lastBackupAt:null,pendingBackup:false,lastError:null,uploading:false }; }
  async stop() { this.stopped = true; clearTimeout(this.timer); this.controller.abort(); await this.pending; await this.storage?.stop(); }
}

export function registerCloud(app: FastifyInstance, sync: CloudSync) {
  app.get('/api/cloud/status', { preHandler: app.requireAuth }, (_req, reply) => reply.header('Cache-Control', 'no-store').send(sync.status()));
  app.get('/api/cloud/storage/status', { preHandler: app.requirePermission('settings.manage') }, (_req, reply) => reply.header('Cache-Control','no-store').send(sync.storageStatus()));
  app.post('/api/cloud/pair', { preHandler: app.requirePermission('settings.manage') }, async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.status(403).send({ error: 'Only an outlet administrator can pair the service' });
    const body = z.object({ code: z.string().min(1).max(200), cloudUrl: z.string().url() }).strict().parse(req.body);
    await sync.pair(body.cloudUrl, body.code); void sync.tick();
    return sync.status();
  });
  app.addHook('onReady', async () => { sync.start(); });
  app.addHook('preClose', async () => { await sync.stop(); });
}
