/**
 * Restore from Cloud Backup
 * 
 * Usage:
 *   npx tsx src/database/restore-from-cloud.ts <backup-url>
 * 
 * Example:
 *   npx tsx src/database/restore-from-cloud.ts https://your-vps.com/api/backups/shop-pc-01/backup-full-2026-05-06.sql
 * 
 * Environment variables required:
 *   DATABASE_URL          - PostgreSQL connection string
 *   BACKUP_CLOUD_SECRET   - Shared secret for authentication
 */

import dotenv from 'dotenv';
dotenv.config();

import { backupService } from '../modules/backup/backup.service.js';

const backupUrl = process.argv[2];

if (!backupUrl) {
  console.error('Usage: npx tsx src/database/restore-from-cloud.ts <backup-url>');
  console.error('Example: npx tsx src/database/restore-from-cloud.ts https://your-vps.com/api/backups/shop-pc-01/backup-full-2026-05-06.sql');
  process.exit(1);
}

const cloudSecret = process.env.BACKUP_CLOUD_SECRET;
if (!cloudSecret) {
  console.error('Error: BACKUP_CLOUD_SECRET not set in .env');
  process.exit(1);
}

console.log('⚠️  WARNING: This will DROP and REPLACE your current database!');
console.log('All local data will be lost.');

const readline = await import('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const answer = await new Promise<string>((resolve) => {
  rl.question('Type "RESTORE" to confirm: ', resolve);
});
rl.close();

if (answer !== 'RESTORE') {
  console.log('Restore cancelled.');
  process.exit(0);
}

console.log('\n🔄 Starting restore...\n');
const result = await backupService.restoreFromCloud(backupUrl, cloudSecret);

if (result.success) {
  console.log('\n✅ ' + result.message);
  console.log('Restart the server to apply changes.');
} else {
  console.error('\n❌ ' + result.message);
  process.exit(1);
}
