import dotenv from "dotenv";
import type { SignOptions } from "jsonwebtoken";

dotenv.config({ quiet: true });

// Type aliases for JWT config
type ExpiresIn = SignOptions['expiresIn'];

// Security: Fail startup if critical secrets are not set in production
const requiredSecrets = ['JWT_SECRET', 'BETTER_AUTH_SECRET'];
if (process.env.NODE_ENV === 'production') {
  const missing = requiredSecrets.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables in production: ${missing.join(', ')}`);
    process.exit(1);
  }
}

export const JWT_CONFIG: { secret: string; expiresIn: ExpiresIn; refreshExpiresIn: ExpiresIn } = {
  secret: process.env.JWT_SECRET || 'hss-secret-key',
  expiresIn: (process.env.JWT_EXPIRES_IN || '15m') as ExpiresIn,
  refreshExpiresIn: (process.env.JWT_REFRESH_EXPIRES_IN || '7d') as ExpiresIn
};

export const CORS_CONFIG = {
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:3000,http://127.0.0.1:47831',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID'],
  credentials: true
};

export const SERVER_CONFIG = {
  port: parseInt(process.env.PORT || '3000'),
  env: process.env.NODE_ENV || 'development'
};

// Verbose request / query logging. Off by default in production (every request
// was logged twice plus raw query dumps), on by default in development. Set
// DEBUG_LOGS=true/false to force either way. Slow-request warnings ([SLOW])
// are NOT gated by this — they always print.
export const DEBUG_LOGS = process.env.DEBUG_LOGS !== undefined
  ? process.env.DEBUG_LOGS === 'true'
  : SERVER_CONFIG.env !== 'production';

// Startup schema/migration work (migrations, DDL, backfills, seeds) runs on
// every boot by default so nothing changes out of the box. Production deploys
// that apply migrations at deploy time (`npm run db:migrate`) can set
// RUN_STARTUP_SCHEMA=false to start the server immediately instead.
export const STARTUP_SCHEMA = process.env.RUN_STARTUP_SCHEMA !== 'false';

// Offline desktop build: no cloud/SMS/email/payment calls, and the local API
// is served on 127.0.0.1. Core POS, inventory, debts, expenses and reports all
// continue to work exactly as normal.
export const OFFLINE_MODE = process.env.OFFLINE_MODE === 'true';
