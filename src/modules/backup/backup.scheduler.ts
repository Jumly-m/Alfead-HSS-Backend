import cron from 'node-cron';
import { pool } from '../../config/drizzle.js';
import { backupService } from './backup.service.js';

class BackupScheduler {
  private scheduledTasks: Map<string, any> = new Map();
  private lastBackupCheck = new Map<string, Date>();
  private internetOnline = false;
  private connectivityCheckInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  async initialize(): Promise<void> {
    console.log('📅 Initializing backup scheduler...');
    
    await this.ensureDefaultBackupSettings();

    // Daily backup at 23:00 Tanzania time (20:00 UTC)
    const dailyTask = cron.schedule('0 20 * * *', async () => {
      console.log('📅 Running daily backup at 23:00 Tanzania time...');
      await this.processScheduledBackups();
    });
    
    // Every 15 minutes: check internet + retry pending cloud uploads
    const cloudRetryTask = cron.schedule('*/15 * * * *', async () => {
      await this.checkInternetAndRetryUploads();
    });

    // Hourly health check: verify daily backup completed (log only, never auto-create)
    const hourlyCheck = cron.schedule('30 * * * *', async () => {
      await this.verifyDailyBackup();
    });

    this.scheduledTasks.set('daily', dailyTask);
    this.scheduledTasks.set('cloud-retry', cloudRetryTask);
    this.scheduledTasks.set('hourly-check', hourlyCheck);
    
    // Initial internet check
    await this.checkInternetAndRetryUploads();
    
    console.log('✅ Backup scheduler initialized (daily at 23:00 Tanzania time + cloud retry every 15min + hourly health check)');
  }

  private async checkInternetAndRetryUploads(): Promise<void> {
    try {
      const wasOnline = this.internetOnline;
      this.internetOnline = await backupService.isOnline();

      if (this.internetOnline && !wasOnline) {
        console.log('🌐 Internet connection detected! Checking for pending cloud uploads...');
        const result = await backupService.retryPendingCloudUploads();
        if (result.uploaded > 0) {
          console.log(`✅ Auto-uploaded ${result.uploaded} backup(s) to cloud`);
        }
      } else if (this.internetOnline) {
        // Still online, check if there are pending uploads anyway (e.g., after a failed attempt)
        const result = await backupService.retryPendingCloudUploads();
        if (result.uploaded > 0) {
          console.log(`✅ Auto-uploaded ${result.uploaded} pending backup(s) to cloud`);
        }
      } else if (wasOnline && !this.internetOnline) {
        console.log('⚠️ Internet connection lost. Cloud uploads will resume when connection returns.');
      }
    } catch (error: any) {
      console.error('[Backup Scheduler] Internet check error:', error.message);
    }
  }

  private async ensureDefaultBackupSettings(): Promise<void> {
    try {
      const existing = await pool.query(
        `SELECT COUNT(*) as count FROM backup_settings WHERE is_enabled = true`
      );

      if (parseInt(existing.rows[0].count) === 0) {
        const now = new Date();
        const nextBackup = new Date(now);
        nextBackup.setUTCHours(20, 0, 0, 0);
        if (nextBackup <= now) {
          nextBackup.setUTCDate(nextBackup.getUTCDate() + 1);
        }
        console.log(`📅 No enabled backup settings found. Creating default daily backup at 23:00 Tanzania time (next: ${nextBackup.toISOString()})...`);
        await pool.query(
          `INSERT INTO backup_settings (tenant_id, shop_id, backup_type, backup_location, frequency, retention_days, is_enabled, next_backup_at)
           VALUES (NULL, NULL, 'full', 'local', 'daily', 90, true, $1)
           ON CONFLICT DO NOTHING`,
          [nextBackup.toISOString()]
        );
        console.log(`✅ Default daily backup settings created (23:00 daily, 90 days retention, next: ${nextBackup.toISOString()})`);
      }
    } catch (error: any) {
      console.error('Failed to create default backup settings:', error.message);
    }
  }

  private async runBackup(tenantId: string | null, shopId: string | null, backupType: string): Promise<void> {
    const key = `${tenantId || 'system'}-${shopId || 'all'}`;
    console.log(`⏰ Scheduled backup for shop: ${shopId || 'all'}`);
    try {
      const isOnline = await backupService.isOnline();
      console.log(`[Backup] Internet status: ${isOnline ? 'Online' : 'Offline'} - backup will be created locally`);

      const result = await backupService.createBackup(
        tenantId || undefined,
        shopId || undefined,
        backupType as 'full' | 'shop'
      );

      if (result.cloudUploaded) {
        console.log(`✅ Backup completed and uploaded for shop ${shopId}`);
      } else {
        console.log(`✅ Backup saved locally (cloud upload pending) for shop ${shopId}`);
      }
    } catch (error: any) {
      console.error(`❌ Backup failed for shop ${shopId}:`, error.message);
    }
  }

  async processScheduledBackups(): Promise<void> {
    if (this.isProcessing) {
      console.log('📅 Backup already in progress, skipping...');
      return;
    }

    this.isProcessing = true;
    try {
      const settingsResult = await pool.query(
        `SELECT * FROM backup_settings WHERE is_enabled = true`
      );

      if (settingsResult.rows.length === 0) {
        console.log('📅 No enabled backup settings. Skipping.');
        return;
      }

      for (const settings of settingsResult.rows) {
        const now = new Date();
        const nextBackup = new Date(settings.next_backup_at);

        if (nextBackup <= now) {
          const key = `${settings.tenant_id || 'system'}-${settings.shop_id || 'all'}`;
          const lastCheck = this.lastBackupCheck.get(key);
          if (lastCheck && (now.getTime() - lastCheck.getTime()) < 23 * 60 * 60 * 1000) {
            continue;
          }

          this.lastBackupCheck.set(key, now);

          if (settings.shop_id) {
            await this.runBackup(settings.tenant_id, settings.shop_id, settings.backup_type);
          } else {
            const tenants = await pool.query(
              'SELECT DISTINCT tenant_id FROM shops WHERE is_active = true AND tenant_id IS NOT NULL ORDER BY tenant_id'
            );
            console.log(`📅 Global backup: creating backup for ${tenants.rows.length} tenant(s)`);
            for (const t of tenants.rows) {
              await this.runBackup(t.tenant_id, null, settings.backup_type);
            }
          }
        }
      }
    } catch (error: any) {
      console.error('Error processing scheduled backups:', error.message);
    } finally {
      this.isProcessing = false;
    }
  }

  async verifyDailyBackup(): Promise<void> {
    try {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      
      const recentBackup = await pool.query(
        `SELECT * FROM backup_history 
         WHERE status = 'completed' 
         AND created_at >= $1 
         ORDER BY created_at DESC LIMIT 1`,
        [todayStart]
      );

      if (recentBackup.rows.length === 0) {
        const nextSettings = await pool.query(
          `SELECT next_backup_at FROM backup_settings WHERE is_enabled = true LIMIT 1`
        );
        if (nextSettings.rows.length > 0) {
          const nextBackup = new Date(nextSettings.rows[0].next_backup_at);
          console.log(`⏳ No backup completed today. Next scheduled backup at ${nextBackup.toISOString()}`);
        } else {
          console.log('⚠️ No backup completed today and no backup settings configured.');
        }
      } else {
        const backup = recentBackup.rows[0];
        const hoursAgo = (now.getTime() - new Date(backup.created_at).getTime()) / (1000 * 60 * 60);
        const cloudStatus = backup.cloud_uploaded ? '☁️ uploaded' : '📁 local only';
        console.log(`✅ Last backup completed ${Math.round(hoursAgo * 10) / 10}h ago: ${backup.filename} (${cloudStatus})`);
      }
    } catch (error: any) {
      console.error('Error verifying daily backup:', error.message);
    }
  }

  async updateSchedule(tenantId: string, shopId: string | null, frequency: string): Promise<void> {
    const key = `${tenantId}-${shopId || 'system'}`;
    const existingTask = this.scheduledTasks.get(key);
    if (existingTask) {
      existingTask.stop();
      this.scheduledTasks.delete(key);
    }

    let cronExpression: string;
    switch (frequency) {
      case 'daily':
        cronExpression = '0 20 * * *'; // 23:00 Tanzania (UTC+3)
        break;
      case 'weekly':
        cronExpression = '0 20 * * 0'; // 23:00 Tanzania (UTC+3)
        break;
      case 'monthly':
        cronExpression = '0 20 1 * *'; // 23:00 Tanzania (UTC+3)
        break;
      default:
        cronExpression = '0 20 * * *'; // 23:00 Tanzania (UTC+3)
    }

    const task = cron.schedule(cronExpression, async () => {
      console.log(`⏰ Running scheduled backup for ${key}`);
      try {
        await backupService.createBackup(tenantId, shopId || undefined, 'full');
        console.log(`✅ Scheduled backup completed for ${key}`);
      } catch (error: any) {
        console.error(`❌ Scheduled backup failed for ${key}:`, error.message);
      }
    });

    this.scheduledTasks.set(key, task);
    console.log(`📅 Backup schedule updated: ${frequency} for ${key}`);
  }

  stop(): void {
    for (const task of this.scheduledTasks.values()) {
      task.stop();
    }
    this.scheduledTasks.clear();
    if (this.connectivityCheckInterval) {
      clearInterval(this.connectivityCheckInterval);
    }
    console.log('🛑 Backup scheduler stopped');
  }
}

export const backupScheduler = new BackupScheduler();
