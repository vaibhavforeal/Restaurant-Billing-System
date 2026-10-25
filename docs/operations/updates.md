# Automatic updates

The installed customer edition of ForkFlow checks GitHub for new versions, downloads them in the
background, and installs them when an admin chooses, never in the middle of service. Demo and
development builds do not update themselves; Settings says so.

## For the restaurant (admin)

Open **Settings → Updates**.

- **Update channel**
  - **Stable** (recommended): full releases only.
  - **Patch**: also hotfix builds as soon as they are released, like a service pack.
    Switching back to Stable keeps the current version until a newer stable release is out; it
    never goes back to an older version.
- **Check now** checks immediately. ForkFlow also checks a minute after it starts and every six
  hours. Downloads continue in the background while you work; only the changed parts of the app
  are downloaded.
- When the update is downloaded, **Restart & update** appears. It works only when no order is open
  or waiting for payment, because every counter disconnects for about a minute. Windows asks for
  administrator permission, then ForkFlow reopens on the new version.
- If you don't install it, the update installs the next time ForkFlow is quit from the tray.

ForkFlow takes a **pre-update backup** automatically the first time the new version starts
(Settings → Backups & connections lists it). Kitchen displays and counters reconnect on their own.

## For the ForkFlow team: publishing a release

Releases are published to GitHub Releases on `vaibhavforeal/Restaurant-Billing-System`.

1. Raise `version` in `package.json` (for example `0.8.0` for a release, `0.8.1` for a hotfix).
2. In PowerShell, set the release key and a GitHub token with permission to create releases:
   ```powershell
   $env:FORKFLOW_LICENSE_PUBLIC_KEY = Get-Content 'C:\secure\license-public.pem' -Raw
   $env:GH_TOKEN = '<token>'
   ```
3. Build and upload:
   - **Stable release**: `npm run release:stable`. It uploads as a **draft**; check it, then publish
     it on GitHub. Restaurants on both channels then receive it.
   - **Patch (hotfix)**: `npm run release:patch`. It is published at once as a **pre-release**,
     which only installations on the Patch channel take. To give it to everyone, edit the release
     on GitHub and clear "Set as a pre-release".

Each release contains the installer, its `.blockmap` (used for small, partial downloads) and
`latest.yml`. Do not rename or remove these files; the updater needs all three.
