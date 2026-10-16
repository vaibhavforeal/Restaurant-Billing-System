import {expect,it} from 'vitest';
import {Pool} from 'pg';
import argon2 from 'argon2';
import {testPostgres} from './testing/postgres.js';
import {applyMigrations} from './migrate.js';
import {bootstrapAdmin} from './bootstrap-admin.js';

it('creates the first administrator once and never promotes or overwrites an account',async()=>{
 const database=await testPostgres(),pool=new Pool({connectionString:database.url});
 try{
  await applyMigrations(pool,'disposable-runtime-password');
  const results=await Promise.allSettled([bootstrapAdmin(pool,'Admin@example.test','a strong bootstrap password'),bootstrapAdmin(pool,'other@example.test','another strong password')]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  const rows=(await pool.query('SELECT * FROM accounts')).rows;expect(rows).toHaveLength(1);
  expect(rows[0].platform_role).toBe('platform_admin');
  expect(await argon2.verify(rows[0].password_hash,rows[0].email==='admin@example.test'?'a strong bootstrap password':'another strong password')).toBe(true);
  await expect(bootstrapAdmin(pool,'admin@example.test','replacement password')).rejects.toThrow(/already/);
  expect((await pool.query('SELECT password_hash FROM accounts')).rows[0].password_hash).toBe(rows[0].password_hash);
 }finally{await pool.end();await database.stop();}
},120000);
