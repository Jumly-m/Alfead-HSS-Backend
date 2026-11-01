import pg from 'pg';
import { hashPassword } from '@better-auth/utils/password';
const { Client } = pg;
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const email = process.argv[2];
const pw = process.argv[3];
if (!email || !pw) { console.error('usage: node reset-pw.mjs <email> <new-password>'); process.exit(1); }
const h = await hashPassword(pw);
const u = await c.query(`SELECT id FROM "user" WHERE LOWER(email) = LOWER($1)`, [email]);
if (u.rows.length === 0) { console.error('user not found'); process.exit(1); }
const userId = u.rows[0].id;
await c.query(`DELETE FROM account WHERE user_id = $1 AND provider_id = 'credential'`, [userId]);
await c.query(`INSERT INTO account (id, user_id, provider_id, account_id, password, created_at, updated_at)
  VALUES (gen_random_uuid()::text, $1, 'credential', $1, $2, NOW(), NOW())`, [userId, h]);
await c.query(`UPDATE "user" SET email_verified = true WHERE id = $1`, [userId]);
console.log('Password reset to scrypt for', email);
await c.end();
