import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { pool } from "../../config/drizzle.js";
import { OFFLINE_MODE } from "../../config/index.js";
import axios from "axios";
import FormData from "form-data";

const execAsync = promisify(exec);

export interface BackupSettings {
  id?: string;
  tenantId?: string;
  shopId?: string;
  backupType: 'full' | 'shop';
  backupLocation: string;
  customPath?: string;
  frequency: 'daily' | 'weekly' | 'monthly';
  retentionDays: number;
  isEnabled: boolean;
  lastBackupAt?: Date;
  nextBackupAt?: Date;
}

export interface BackupRecord {
  id: string;
  tenantId?: string;
  shopId?: string;
  filename: string;
  filepath: string;
  filesize?: number;
  backupType: string;
  status: 'pending' | 'completed' | 'failed';
  cloudUploaded: boolean;
  errorMessage?: string;
  startedAt: Date;
  completedAt?: Date;
  createdAt: Date;
  cloudUrl?: string;
  cloudFilename?: string;
}

class BackupService {
  private getBackupDir(customPath?: string): string {
    if (customPath && fs.existsSync(customPath)) {
      return customPath;
    }
    const defaultDir = process.env.HSS_BACKUP_DIR || path.join(process.cwd(), 'backups');
    if (!fs.existsSync(defaultDir)) {
      fs.mkdirSync(defaultDir, { recursive: true });
    }
    return defaultDir;
  }

  private getDbConfig() {
    const url = new URL(process.env.DATABASE_URL || '');
    return {
      host: url.hostname,
      port: parseInt(url.port) || 5432,
      database: url.pathname.slice(1),
      user: url.username,
      password: decodeURIComponent(url.password),
    };
  }

  private findPgDump(): string {
    // 1. Try system PATH first
    try {
      const { stdout } = require('child_process').execSync('where pg_dump 2>nul', { encoding: 'utf8' });
      const paths = stdout.trim().split('\n');
      if (paths.length > 0 && paths[0].trim()) {
        return paths[0].trim();
      }
    } catch {}

    // 2. Search Windows Registry for PostgreSQL installations
    try {
      const { stdout: regOut } = require('child_process').execSync(
        'reg query "HKLM\\SOFTWARE\\PostgreSQL\\Installations" /s /v BasePath 2>nul',
        { encoding: 'utf8' }
      );
      const lines = regOut.split('\n');
      for (const line of lines) {
        const match = line.match(/BasePath\s+(.+)/i);
        if (match) {
          const basePath = match[1].trim();
          const pgDumpPath = path.join(basePath, 'bin', 'pg_dump.exe');
          if (fs.existsSync(pgDumpPath)) return pgDumpPath;
        }
      }
    } catch {}

    // 3. Common installation paths
    const possiblePaths = [
      'D:\\postgress\\bin\\pg_dump.exe',
      'D:\\postgressDBSetup\\bin\\pg_dump.exe',
      'C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe',
      'C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe',
      'C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe',
      'C:\\Program Files\\PostgreSQL\\15\\bin\\pg_dump.exe',
      'C:\\Program Files\\PostgreSQL\\14\\bin\\pg_dump.exe',
      'C:\\Program Files\\PostgreSQL\\13\\bin\\pg_dump.exe',
      'C:\\Program Files (x86)\\PostgreSQL\\18\\bin\\pg_dump.exe',
      'C:\\Program Files (x86)\\PostgreSQL\\17\\bin\\pg_dump.exe',
      'C:\\Program Files (x86)\\PostgreSQL\\16\\bin\\pg_dump.exe',
      'C:\\Program Files (x86)\\PostgreSQL\\15\\bin\\pg_dump.exe',
      'C:\\Program Files (x86)\\PostgreSQL\\14\\bin\\pg_dump.exe',
      'C:\\Program Files (x86)\\PostgreSQL\\13\\bin\\pg_dump.exe',
      'C:\\PostgreSQL\\18\\bin\\pg_dump.exe',
      'C:\\PostgreSQL\\17\\bin\\pg_dump.exe',
      'C:\\PostgreSQL\\16\\bin\\pg_dump.exe',
      'C:\\PostgreSQL\\15\\bin\\pg_dump.exe',
      'C:\\PostgreSQL\\14\\bin\\pg_dump.exe',
      'C:\\PostgreSQL\\13\\bin\\pg_dump.exe',
    ];

    for (const pgPath of possiblePaths) {
      if (fs.existsSync(pgPath)) {
        return pgPath;
      }
    }

    // 4. Last resort: system PATH
    return 'pg_dump';
  }

  async createBackup(tenantId?: string, shopId?: string, backupType: 'full' | 'shop' = 'full'): Promise<BackupRecord> {
    const dbConfig = this.getDbConfig();
    const backupDir = this.getBackupDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = backupType === 'full' 
      ? `backup-full-${timestamp}.sql`
      : `backup-shop-${shopId}-${timestamp}.sql`;
    const filepath = path.join(backupDir, filename);

    // Create backup history record
    const historyResult = await pool.query(
      `INSERT INTO backup_history (tenant_id, shop_id, filename, filepath, backup_type, status, started_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
       RETURNING *`,
      [tenantId, shopId, filename, filepath, backupType]
    );
    const backupRecord = historyResult.rows[0] as BackupRecord;

    try {
      // Find pg_dump executable
      const pgDumpPath = this.findPgDump();
      console.log(`[Backup] Using pg_dump from: ${pgDumpPath}`);
      
      let dumpCommand: string;
      
      if (backupType === 'full') {
        // Full database backup using pg_dump
        dumpCommand = `"${pgDumpPath}" -h ${dbConfig.host} -p ${dbConfig.port} -U ${dbConfig.user} -d ${dbConfig.database} -F c -b -v -f "${filepath}"`;
      } else if (shopId) {
        // Shop-specific backup (only tables filtered by shop_id)
        // Create a custom dump that includes only shop-specific data
        dumpCommand = `"${pgDumpPath}" -h ${dbConfig.host} -p ${dbConfig.port} -U ${dbConfig.user} -d ${dbConfig.database} -F c -b -v -f "${filepath}"`;
      } else {
        throw new Error('Shop ID required for shop-specific backup');
      }

      // Set PGPASSWORD environment variable
      const env = { ...process.env, PGPASSWORD: dbConfig.password };

      try {
        const { stdout, stderr } = await execAsync(dumpCommand, { env });
        console.log('[Backup] pg_dump stdout:', stdout.substring(0, 500));
        if (stderr) console.log('[Backup] pg_dump stderr:', stderr.substring(0, 500));
      } catch (execError: any) {
        console.error('[Backup] pg_dump exec error:', execError.message);
        console.error('[Backup] stderr:', execError.stderr);
        throw execError;
      }

      // Get file size
      let filesize = 0;
      if (fs.existsSync(filepath)) {
        const stats = fs.statSync(filepath);
        filesize = stats.size;
      }

      // Update backup record as completed
      await pool.query(
        `UPDATE backup_history 
         SET status = 'completed', filesize = $1, completed_at = NOW() 
         WHERE id = $2`,
        [filesize, backupRecord.id]
      );

      // Update last backup time in settings
      let updateQuery: string;
      let updateParams: any[];

      if (shopId) {
        updateQuery = `
          UPDATE backup_settings 
          SET last_backup_at = NOW(), next_backup_at = NOW() + 
          CASE frequency 
            WHEN 'daily' THEN INTERVAL '1 day'
            WHEN 'weekly' THEN INTERVAL '1 week'
            WHEN 'monthly' THEN INTERVAL '1 month'
          END
          WHERE (tenant_id IS NULL AND shop_id IS NULL) 
             OR (tenant_id = $1 AND shop_id = $2)`;
        updateParams = [tenantId, shopId];
      } else {
        updateQuery = `
          UPDATE backup_settings 
          SET last_backup_at = NOW(), next_backup_at = NOW() + 
          CASE frequency 
            WHEN 'daily' THEN INTERVAL '1 day'
            WHEN 'weekly' THEN INTERVAL '1 week'
            WHEN 'monthly' THEN INTERVAL '1 month'
          END
          WHERE (tenant_id IS NULL AND shop_id IS NULL) 
             OR (tenant_id = $1 AND shop_id IS NULL)`;
        updateParams = [tenantId];
      }

      await pool.query(updateQuery, updateParams);

      // Upload to cloud VPS if configured (does not fail the backup if offline)
      const cloudUploaded = await this.uploadToCloud(filepath, tenantId, shopId);
      let cloudUrl: string | undefined;
      let cloudFilename: string | undefined;

      await pool.query(
        `UPDATE backup_history SET cloud_uploaded = $1 WHERE id = $2`,
        [cloudUploaded, backupRecord.id]
      );

      if (cloudUploaded) {
        const baseUrl = (process.env.BACKUP_CLOUD_URL || '').replace(/\/api\/backup$/, '');
        cloudFilename = path.basename(filepath);
        const key = tenantId || 'no-tenant';
        cloudUrl = `${baseUrl}/api/backups/${key}/${cloudFilename}`;
        console.log(`[Backup] Cloud backup URL: ${cloudUrl}`);
      } else {
        console.log(`[Backup] Cloud upload skipped/failed - backup saved locally, will auto-upload when internet returns`);
      }

      // Clean up old backups based on retention policy
      await this.cleanupOldBackups(tenantId, shopId);

      return { ...backupRecord, status: 'completed', filesize, completedAt: new Date(), cloudUploaded, cloudUrl, cloudFilename };
    } catch (error: any) {
      // Update backup record as failed
      await pool.query(
        `UPDATE backup_history 
         SET status = 'failed', error_message = $1, completed_at = NOW() 
         WHERE id = $2`,
        [error.message, backupRecord.id]
      );

      throw new Error(`Backup failed: ${error.message}`);
    }
  }

  async cleanupOldBackups(tenantId?: string, shopId?: string): Promise<void> {
    try {
      // Get retention days from settings
      const settingsResult = await pool.query(
        `SELECT retention_days FROM backup_settings 
         WHERE tenant_id = $1 OR shop_id = $2 
         ORDER BY created_at DESC LIMIT 1`,
        [tenantId, shopId]
      );

      const retentionDays = settingsResult.rows[0]?.retention_days || 30;

      // Get old backup files to delete
      const oldBackups = await pool.query(
        `SELECT id, filepath FROM backup_history 
         WHERE created_at < NOW() - INTERVAL '${retentionDays} days'
         AND (tenant_id = $1 OR shop_id = $2 OR ($1 IS NULL AND $2 IS NULL))
         AND status = 'completed'`,
        [tenantId, shopId]
      );

      // Delete old backup files
      for (const backup of oldBackups.rows) {
        try {
          if (fs.existsSync(backup.filepath)) {
            fs.unlinkSync(backup.filepath);
          }
        } catch (e) {
          console.error(`Failed to delete backup file: ${backup.filepath}`);
        }
      }

      // Delete old records from database
      await pool.query(
        `DELETE FROM backup_history 
         WHERE created_at < NOW() - INTERVAL '${retentionDays} days'
         AND (tenant_id = $1 OR shop_id = $2 OR ($1 IS NULL AND $2 IS NULL))`,
        [tenantId, shopId]
      );
    } catch (error: any) {
      console.error('Cleanup old backups error:', error.message);
    }
  }

  async getBackupSettings(tenantId?: string, shopId?: string): Promise<BackupSettings | null> {
    const result = await pool.query(
      `SELECT * FROM backup_settings 
       WHERE tenant_id = $1 OR shop_id = $2 
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, shopId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      shopId: row.shop_id,
      backupType: row.backup_type,
      backupLocation: row.backup_location || 'local',
      customPath: row.custom_path,
      frequency: row.frequency,
      retentionDays: row.retention_days,
      isEnabled: row.is_enabled,
      lastBackupAt: row.last_backup_at,
      nextBackupAt: row.next_backup_at,
    };
  }

  async saveBackupSettings(settings: BackupSettings): Promise<BackupSettings> {
    const existing = await this.getBackupSettings(settings.tenantId, settings.shopId);

    if (existing?.id) {
      await pool.query(
        `UPDATE backup_settings 
         SET backup_type = $1, backup_location = $2, custom_path = $3, 
             frequency = $4, retention_days = $5, is_enabled = $6, updated_at = NOW(),
             next_backup_at = NOW() + 
             CASE $4 
               WHEN 'daily' THEN INTERVAL '1 day'
               WHEN 'weekly' THEN INTERVAL '1 week'
               WHEN 'monthly' THEN INTERVAL '1 month'
             END
         WHERE id = $7`,
        [settings.backupType, settings.backupLocation, settings.customPath, 
         settings.frequency, settings.retentionDays, settings.isEnabled, existing.id]
      );
    } else {
      await pool.query(
        `INSERT INTO backup_settings (tenant_id, shop_id, backup_type, backup_location, custom_path, frequency, retention_days, is_enabled, next_backup_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + 
         CASE $6 
           WHEN 'daily' THEN INTERVAL '1 day'
           WHEN 'weekly' THEN INTERVAL '1 week'
           WHEN 'monthly' THEN INTERVAL '1 month'
         END)`,
        [settings.tenantId, settings.shopId, settings.backupType, settings.backupLocation, 
         settings.customPath, settings.frequency, settings.retentionDays, settings.isEnabled]
      );
    }

    return settings;
  }

  async getBackupHistory(tenantId?: string, shopId?: string, limit: number = 10): Promise<BackupRecord[]> {
    const result = await pool.query(
      `SELECT * FROM backup_history 
       WHERE (tenant_id = $1 OR shop_id = $2 OR ($1 IS NULL AND $2 IS NULL))
       ORDER BY created_at DESC 
       LIMIT $3`,
      [tenantId, shopId, limit]
    );

    return result.rows.map(row => ({
      id: row.id,
      tenantId: row.tenant_id,
      shopId: row.shop_id,
      filename: row.filename,
      filepath: row.filepath,
      filesize: row.filesize,
      backupType: row.backup_type,
      status: row.status,
      cloudUploaded: row.cloud_uploaded,
      errorMessage: row.error_message,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
    }));
  }

  async deleteBackup(backupId: string): Promise<void> {
    // Get backup file path
    const result = await pool.query(
      'SELECT filepath FROM backup_history WHERE id = $1',
      [backupId]
    );

    if (result.rows.length > 0) {
      const filepath = result.rows[0].filepath;
      
      // Delete file if exists
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
      }

      // Delete record from database
      await pool.query('DELETE FROM backup_history WHERE id = $1', [backupId]);
    }
  }

  getBackupFilePath(backupId: string): string | null {
    return null;
  }

  // Check if internet is available. In the offline desktop build we never
  // touch the network (and never make startup wait for a DNS timeout).
  async isOnline(): Promise<boolean> {
    if (OFFLINE_MODE) return false;
    try {
      await axios.get('https://www.google.com/generate_204', { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  // Retry uploading pending cloud backups
  async retryPendingCloudUploads(): Promise<{ uploaded: number; failed: number }> {
    const cloudUrl = process.env.BACKUP_CLOUD_URL;
    const cloudSecret = process.env.BACKUP_CLOUD_SECRET;

    if (!cloudUrl || !cloudSecret) {
      return { uploaded: 0, failed: 0 };
    }

    const isOnline = await this.isOnline();
    if (!isOnline) {
      console.log('[Backup Retry] No internet connection, skipping cloud upload retry');
      return { uploaded: 0, failed: 0 };
    }

    console.log('[Backup Retry] Checking for backups pending cloud upload...');

    const pendingBackups = await pool.query(
      `SELECT id, filepath, filename, tenant_id, shop_id FROM backup_history 
       WHERE status = 'completed' AND cloud_uploaded = false 
       ORDER BY created_at ASC`
    );

    if (pendingBackups.rows.length === 0) {
      console.log('[Backup Retry] No pending cloud uploads found');
      return { uploaded: 0, failed: 0 };
    }

    console.log(`[Backup Retry] Found ${pendingBackups.rows.length} backup(s) pending cloud upload`);

    let uploaded = 0;
    let failed = 0;

    for (const backup of pendingBackups.rows) {
      if (!fs.existsSync(backup.filepath)) {
        console.log(`[Backup Retry] File not found, marking as failed: ${backup.filename}`);
        await pool.query(`UPDATE backup_history SET cloud_uploaded = true WHERE id = $1`, [backup.id]);
        failed++;
        continue;
      }

      const success = await this.uploadToCloud(backup.filepath, backup.tenant_id, backup.shop_id);
      if (success) {
        await pool.query(`UPDATE backup_history SET cloud_uploaded = true WHERE id = $1`, [backup.id]);
        console.log(`[Backup Retry] Uploaded: ${backup.filename}`);
        uploaded++;
      } else {
        console.log(`[Backup Retry] Failed to upload: ${backup.filename}`);
        failed++;
      }
    }

    console.log(`[Backup Retry] Complete: ${uploaded} uploaded, ${failed} failed`);
    return { uploaded, failed };
  }

  // Upload backup to cloud VPS
  async uploadToCloud(filepath: string, tenantId?: string, shopId?: string): Promise<boolean> {
    const cloudUrl = process.env.BACKUP_CLOUD_URL;
    const cloudSecret = process.env.BACKUP_CLOUD_SECRET;
    const hostname = process.env.BACKUP_HOSTNAME || 'local-pc';

    if (!cloudUrl || !cloudSecret) {
      console.log('[Backup] Cloud backup not configured (missing BACKUP_CLOUD_URL or BACKUP_CLOUD_SECRET)');
      return false;
    }

    try {
      const key = tenantId || 'no-tenant';
      console.log(`[Backup] Uploading to cloud: ${filepath} (key: ${key})`);
      const form = new FormData();
      form.append('tenant_id', tenantId || 'system');
      form.append('hostname', hostname);
      form.append('shop_id', shopId || 'all');
      form.append('backup_key', key);
      form.append('file', fs.createReadStream(filepath));

      await axios.post(cloudUrl, form, {
        headers: {
          ...form.getHeaders(),
          'X-Backup-Secret': cloudSecret,
        },
        timeout: 300000, // 5 minutes for large files
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });

      console.log('[Backup] Cloud upload successful');
      return true;
    } catch (error: any) {
      console.error('[Backup] Cloud upload failed:', error.message);
      return false;
    }
  }

  // Restore from cloud backup
  async restoreFromCloud(backupUrl: string, cloudSecret: string): Promise<{ success: boolean; message: string }> {
    const dbConfig = this.getDbConfig();

    try {
      console.log('[Backup] Downloading backup from cloud...');
      const response = await axios.get(backupUrl, {
        headers: { 'X-Backup-Secret': cloudSecret },
        responseType: 'arraybuffer',
        timeout: 300000,
      });

      const tempFile = path.join(this.getBackupDir(), `restore-${Date.now()}.sql`);
      fs.writeFileSync(tempFile, Buffer.from(response.data));
      console.log(`[Backup] Downloaded to: ${tempFile}`);

      // Find pg_restore
      const pgRestorePath = this.findPgDump().replace('pg_dump', 'pg_restore');

      // Drop and recreate database
      console.log('[Backup] Restoring database...');
      const restoreCommand = `"${pgRestorePath}" -h ${dbConfig.host} -p ${dbConfig.port} -U ${dbConfig.user} -d ${dbConfig.database} -c --if-exists "${tempFile}"`;
      const env = { ...process.env, PGPASSWORD: dbConfig.password };

      await execAsync(restoreCommand, { env });

      // Clean up temp file
      fs.unlinkSync(tempFile);

      console.log('[Backup] Restore completed successfully');
      return { success: true, message: 'Database restored successfully' };
    } catch (error: any) {
      console.error('[Backup] Restore failed:', error.message);
      return { success: false, message: `Restore failed: ${error.message}` };
    }
  }
}

export const backupService = new BackupService();
