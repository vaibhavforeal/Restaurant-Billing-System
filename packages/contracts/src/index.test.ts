import { describe, expect, it } from 'vitest';
import { SyncEnvelope, Bootstrap, ManagementCommand } from './index.js';

const change = { table: 'bills', key: { id: 'bill-1' }, row: { id: 'bill-1', total_paise: 100 } };
const envelope = { protocolVersion: 1, outletId: 'outlet-1', installationId: 'installation-1', epoch: 'epoch-1', sequence: 1, eventId: 'event-1', occurredAt: 1, changes: [change] };
describe('synchronization trust boundary', () => {
  it('accepts recorded financial facts and rejects credentials and unknown entity kinds', () => {
    expect(SyncEnvelope.parse(envelope).changes[0]!.row!['total_paise']).toBe(100);
    for (const table of ['sessions', 'users', 'printers', 'license_state', 'unknown']) {
      expect(SyncEnvelope.safeParse({ ...envelope, changes: [{ ...change, table }] }).success).toBe(false);
    }
    expect(SyncEnvelope.safeParse({ ...envelope, changes: [{ ...change, row: { password_hash: 'secret' } }] }).success).toBe(false);
  });
  it('rejects unsupported protocol, ambiguous record identity, and invalid sequence', () => {
    expect(SyncEnvelope.safeParse({ ...envelope, protocolVersion: 2 }).success).toBe(false);
    expect(SyncEnvelope.safeParse({ ...envelope, sequence: 0 }).success).toBe(false);
    expect(SyncEnvelope.safeParse({ ...envelope, changes: [{ ...change, key: {} }] }).success).toBe(false);
    expect(Bootstrap.safeParse({ ...envelope, sequence: 0, records: [change], changes: undefined, eventId: undefined, occurredAt: undefined }).success).toBe(false);
    expect(Bootstrap.parse({ protocolVersion: 1, outletId: 'o', installationId: 'i', epoch: 'e', sequence: 0, records: [] }).sequence).toBe(0);
  });
  it('limits remote commands to configuration, never payments or restoration', () => {
    const command = { id: 'c', kind: 'settings.update', targetId: '1', expectedRevision: 0, payload: {}, requestedBy: 'u', createdAt: 1 };
    expect(ManagementCommand.safeParse(command).success).toBe(true);
    for (const kind of ['payment.create', 'backup.restore', 'printer.update']) expect(ManagementCommand.safeParse({ ...command, kind }).success).toBe(false);
  });
});
