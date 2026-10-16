import { z } from 'zod';

export const REPLICATED_TABLES = [
  'settings', 'categories', 'products', 'variants', 'dining_tables', 'kot_stations',
  'orders', 'order_items', 'kots', 'bills', 'bill_taxes', 'bill_report_lines', 'payments',
  'bill_settlements', 'stock_items', 'product_stock_links', 'stock_moves', 'stock_cost_changes',
  'sequences', 'reservations', 'table_links', 'order_table_events', 'credit_notes',
  'credit_note_lines', 'credit_note_taxes', 'refund_payments', 'zomato_orders',
  'zomato_settlements', 'zomato_imports', 'integration_state', 'feature_state',
  'staff_roster', 'cloud_feature_policy', 'cloud_staff_policy', 'cloud_audit',
  'guest_requests', 'guest_service_requests', 'kot_requests', 'outlet_meta',
] as const;
const Identity = z.string().min(1).max(200);
const Sequence = z.number().int().nonnegative().safe();
const forbidden = /(?:^|_)(password|pin|secret|token|credential|private_key|photo_data|receipt_hash)(?:$|_)/i;
const safeValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string().max(2_000_000), z.number().finite(), z.boolean(), z.null(),
  z.array(safeValue).max(20_000),
  z.record(z.string().refine(key => !forbidden.test(key), 'Credentials cannot be replicated'), safeValue),
]));
export const RecordChange = z.object({
  table: z.enum(REPLICATED_TABLES),
  key: z.record(z.string().min(1).max(100), z.union([Identity, z.number().int().safe()])).refine(k => Object.keys(k).length > 0 && Object.keys(k).length <= 6, 'Record identity is required'),
  row: z.record(z.string().refine(key => !forbidden.test(key), 'Credentials cannot be replicated'), safeValue).nullable(),
  revision: Sequence.optional(),
}).strict();
export type RecordChange = z.infer<typeof RecordChange>;
const source = { protocolVersion: z.literal(1), outletId: Identity, installationId: Identity, epoch: Identity };
export const SyncEnvelope = z.object({ ...source, sequence: Sequence.min(1), eventId: Identity, occurredAt: Sequence, changes: z.array(RecordChange).min(1).max(50_000) }).strict();
export type SyncEnvelope = z.infer<typeof SyncEnvelope>;
export const Bootstrap = z.object({ ...source, sequence: Sequence, records: z.array(RecordChange).max(500_000) }).strict();
export type Bootstrap = z.infer<typeof Bootstrap>;
export const CommandKind = z.enum(['settings.update', 'product.update', 'category.update', 'variant.update', 'features.update', 'staff.update']);
export const ManagementCommand = z.object({
  id: Identity, kind: CommandKind, targetId: Identity.optional(), expectedRevision: Sequence,
  payload: z.record(z.string(), safeValue), requestedBy: Identity, createdAt: Sequence,
}).strict().superRefine((command, ctx) => {
  if (command.kind === 'features.update' && command.targetId !== 'policy') ctx.addIssue({ code: 'custom', message: 'Feature policy target must be policy' });
  if (command.kind === 'settings.update' && command.targetId !== '1') ctx.addIssue({ code: 'custom', message: 'Settings target must be 1' });
  if (!command.targetId) ctx.addIssue({ code: 'custom', message: 'Command target is required' });
});
export type ManagementCommand = z.infer<typeof ManagementCommand>;
export const CommandResult = z.object({ id: Identity, status: z.enum(['applied', 'conflict', 'rejected']), revision: Sequence.optional(), error: z.string().max(1000).optional() }).strict();
export type CommandResult = z.infer<typeof CommandResult>;
export const OutletStatus = z.object({
  state: z.enum(['not_paired', 'connected', 'offline', 'error']), outletId: Identity.nullable(),
  lastContact: Sequence.nullable(), acknowledgedSequence: Sequence, pendingUploads: Sequence,
  initialSyncComplete: z.boolean(), lastError: z.string().nullable(), serviceVersion: z.string(),
});
export type OutletStatus = z.infer<typeof OutletStatus>;
