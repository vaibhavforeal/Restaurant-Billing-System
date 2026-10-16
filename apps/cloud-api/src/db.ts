import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
export const token = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export class ApiError extends Error { constructor(public statusCode: number, message: string) { super(message); } }
export async function transaction<T>(pool: Pool, organizationId: string | null, operation: (client: PoolClient) => Promise<T>): Promise<T> {
 const client = await pool.connect();
 try {
  await client.query('BEGIN');
  if (organizationId) await client.query("SELECT set_config('app.organization_id',$1,true)",[organizationId]);
  const result = await operation(client); await client.query('COMMIT'); return result;
 } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
export function canonical(value: unknown): string {
 if(value === null || typeof value !== 'object') return JSON.stringify(value);
 if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
 return '{'+Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>JSON.stringify(key)+':'+canonical(v)).join(',')+'}';
}
