import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FEATURES } from '@forkflow/domain/features';
import { StaffOverrides } from '@forkflow/domain/staff-permissions';
import { ManagementCommand, type CommandResult } from '@forkflow/contracts';
import { CloudJournal } from './cloud-journal.js';
import { updateCatalog, updateSettings } from './configuration-writes.js';

export function applyCommand(app: FastifyInstance, journal: CloudJournal, input: unknown): CommandResult {
  const command = ManagementCommand.parse(input);
  const existing = app.db.prepare('SELECT result_json FROM cloud_command_results WHERE id=?').get(command.id) as { result_json: string } | undefined;
  if (existing) return JSON.parse(existing.result_json) as CommandResult;
  const table = { 'settings.update': 'settings', 'product.update': 'products', 'category.update': 'categories', 'variant.update': 'variants', 'features.update': 'cloud_feature_policy', 'staff.update': 'cloud_staff_policy' }[command.kind];
  const key = { id: command.kind === 'settings.update' ? 1 : command.targetId ?? 'policy' };
  const result = app.db.transaction((): CommandResult => {
    let response: CommandResult;
    const revision = journal.revision(table, key);
    if (revision !== command.expectedRevision) response = { id: command.id, status: 'conflict', revision, error: 'Configuration changed at the outlet. Refresh and review before sending again.' };
    else {
      try {
        // Savepoint keeps a rejected command from committing partially applied configuration.
        app.db.transaction(() => {
          if (command.kind === 'settings.update') updateSettings(app.db, command.payload);
          else if (command.kind === 'features.update') {
            const { enabled } = z.object({ enabled: z.record(z.string(), z.boolean()).refine(values => Object.keys(values).every(id => FEATURES.some(f => f.id === id && f.configurable)), 'Unknown or fixed feature') }).strict().parse(command.payload);
            const previous = app.db.prepare('SELECT enabled FROM cloud_feature_policy WHERE id=?').get('policy') as { enabled: string } | undefined;
            app.db.prepare('INSERT INTO cloud_feature_policy VALUES (?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled').run('policy', JSON.stringify({ ...(previous ? JSON.parse(previous.enabled) : {}), ...enabled }));
          } else if (command.kind === 'staff.update') {
            if (!command.targetId || !app.db.prepare('SELECT id FROM users WHERE id=?').get(command.targetId)) throw new Error('Staff member no longer exists');
            const { overrides } = z.object({ overrides: StaffOverrides }).strict().parse(command.payload);
            app.db.prepare('INSERT INTO cloud_staff_policy VALUES (?,?) ON CONFLICT(id) DO UPDATE SET overrides=excluded.overrides').run(command.targetId, JSON.stringify(overrides));
          } else updateCatalog(app.db, command.kind.split('.')[0] as 'category' | 'product' | 'variant', command.targetId ?? '', command.payload);
        })();
        response = { id: command.id, status: 'applied', revision: journal.state().sequence + 1 };
      } catch (error) { response = { id: command.id, status: 'rejected', error: (error instanceof Error ? error.message : 'Configuration rejected').slice(0, 1000) }; }
    }
    app.db.prepare('INSERT INTO cloud_audit VALUES (?,?,?,?,?)').run(randomUUID(), command.requestedBy, `${command.kind}:${response.status}`, command.targetId ?? '', Date.now());
    app.db.prepare('INSERT INTO cloud_command_results (id,result_json) VALUES (?,?)').run(command.id, JSON.stringify(response));
    return response;
  })();
  if (result.status === 'applied') {
    app.broadcast('catalog.changed', {}); app.broadcast('features.changed', {}); app.broadcast('integrations.changed', {});
  }
  return result;
}
