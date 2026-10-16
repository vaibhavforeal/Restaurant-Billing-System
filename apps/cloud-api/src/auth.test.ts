import { expect, test } from 'vitest';
import { createCloudApi } from './server.js';
import type {Pool} from 'pg';
test('private endpoints require an authenticated account', async () => {
 const app = await createCloudApi({ pool: {} as Pool, portalOrigin: 'https://portal.test', mailer: {async deliver(){}} });
 expect((await app.inject('/v1/auth/me')).statusCode).toBe(401);
 expect((await app.inject('/v1/outlets')).statusCode).toBe(401);
 await app.close();
});
