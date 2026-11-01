import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { requirePermission } from '../../middleware/rbac.middleware.js';
import { backupService } from './backup.service.js';
import { pool } from '../../config/drizzle.js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

const router = new Hono<{
  Variables: {
    userId: string;
    userRole: string;
    tenantId: string;
    shopIds: string[];
  }
}>();

// Get backup settings
router.get('/settings', authMiddleware, async (c) => {
  try {
    const userRole = c.get('userRole');
    const tenantId = c.get('tenantId');
    const shopIds = c.get('shopIds') as string[];
    
    if (userRole !== 'admin' && userRole !== 'owner' && userRole !== 'developer') {
      return c.json({ success: false, error: 'Unauthorized' }, 403);
    }

    const settings = await backupService.getBackupSettings(tenantId, shopIds?.[0]);
    return c.json({ success: true, data: settings });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Save backup settings
router.post('/settings', authMiddleware, async (c) => {
  try {
    const userRole = c.get('userRole');
    const tenantId = c.get('tenantId');
    const shopIds = c.get('shopIds') as string[];
    
    if (userRole !== 'admin' && userRole !== 'owner' && userRole !== 'developer') {
      return c.json({ success: false, error: 'Unauthorized' }, 403);
    }

    const settings = await c.req.json();
    
    const savedSettings = await backupService.saveBackupSettings({
      ...settings,
      tenantId: tenantId || settings.tenantId,
      shopId: shopIds?.[0] || settings.shopId,
    });

    return c.json({ success: true, data: savedSettings });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Get backup history
router.get('/history', authMiddleware, async (c) => {
  try {
    const userRole = c.get('userRole');
    const tenantId = c.get('tenantId');
    const shopIds = c.get('shopIds') as string[];
    
    if (userRole !== 'admin' && userRole !== 'owner' && userRole !== 'developer') {
      return c.json({ success: false, error: 'Unauthorized' }, 403);
    }

    const limit = parseInt(c.req.query('limit') || '10');
    const history = await backupService.getBackupHistory(tenantId, shopIds?.[0], limit);
    return c.json({ success: true, data: history });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Create manual backup
router.post('/create', authMiddleware, async (c) => {
  try {
    const userRole = c.get('userRole');
    const tenantId = c.get('tenantId');
    const shopIds = c.get('shopIds') as string[];
    
    if (userRole !== 'admin' && userRole !== 'owner' && userRole !== 'developer') {
      return c.json({ success: false, error: 'Unauthorized' }, 403);
    }

    const { backupType, shopId } = await c.req.json();
    
    const backupRecord = await backupService.createBackup(
      tenantId,
      shopId || shopIds?.[0],
      backupType || 'full'
    );

    const response: any = {
      success: true,
      data: {
        id: backupRecord.id,
        filename: backupRecord.filename,
        status: backupRecord.status,
        filesize: backupRecord.filesize,
        created_at: backupRecord.createdAt,
      },
    };

    if (backupRecord.cloudUrl) {
      response.data.restore_url = backupRecord.cloudUrl;
      response.data.cloud_filename = backupRecord.cloudFilename;
    }

    return c.json(response);
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Trigger backup (alias for /create, used by dashboard)
router.post('/trigger', authMiddleware, async (c) => {
  try {
    const userRole = c.get('userRole');
    const tenantId = c.get('tenantId');
    const shopIds = c.get('shopIds') as string[];
    
    if (userRole !== 'admin' && userRole !== 'owner' && userRole !== 'developer') {
      return c.json({ success: false, error: 'Unauthorized' }, 403);
    }

    const { type } = await c.req.json().catch(() => ({}));
    
    const backupRecord = await backupService.createBackup(
      tenantId,
      shopIds?.[0],
      type || 'full'
    );

    const response: any = {
      success: true,
      data: {
        id: backupRecord.id,
        filename: backupRecord.filename,
        status: backupRecord.status,
        filesize: backupRecord.filesize,
        created_at: backupRecord.createdAt,
      },
    };

    if (backupRecord.cloudUrl) {
      response.data.restore_url = backupRecord.cloudUrl;
      response.data.cloud_filename = backupRecord.cloudFilename;
      response.message = 'Backup completed and uploaded to cloud. Use restore_url to restore.';
    } else {
      response.message = 'Backup completed locally. Cloud upload failed or not configured.';
    }

    return c.json(response);
  } catch (error: any) {
    console.error('[Backup Trigger] Error:', error.message);
    if (error.stack) console.error('[Backup Trigger] Stack:', error.stack);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// List cloud backups from VPS
router.get('/cloud-list', authMiddleware, async (c) => {
  try {
    const userRole = c.get('userRole');
    if (userRole !== 'admin' && userRole !== 'owner' && userRole !== 'developer') {
      return c.json({ success: false, error: 'Unauthorized' }, 403);
    }

    const cloudUrl = process.env.BACKUP_CLOUD_URL;
    const cloudSecret = process.env.BACKUP_CLOUD_SECRET;
    const tenantId = c.get('tenantId');
    const shopIds = c.get('shopIds') as string[];
    const shopId = c.req.query('shopId') || shopIds?.[0];
    const key = tenantId || 'no-tenant';

    if (!cloudUrl || !cloudSecret) {
      console.log('[Cloud Backup] Not configured, returning empty list');
      return c.json({ success: true, data: { backups: [], key, cloudUrl: null } });
    }

    const baseUrl = cloudUrl.replace(/\/api\/backup$/, '');
    const listUrl = `${baseUrl}/api/backups/${key}`;

    let backups: any[] = [];
    try {
      const response = await axios.get(listUrl, {
        headers: { 'X-Backup-Secret': cloudSecret },
        timeout: 10000,
      });
      backups = (response.data?.backups || []).map((b: any) => ({
        filename: b.filename,
        size_mb: b.size_mb,
        size: b.size,
        created_at: b.created_at,
        download_url: b.download_url,
        restore_url: b.download_url,
        key,
      }));
    } catch (vpsError: any) {
      console.warn('[Cloud Backup] VPS unreachable, returning empty list:', vpsError.message);
    }

    return c.json({ success: true, data: { backups, key, cloudUrl: baseUrl } });
  } catch (error: any) {
    console.error('[Cloud Backup] Unexpected error:', error.message);
    return c.json({ success: true, data: { backups: [], key: null, cloudUrl: null } });
  }
});

// Backup health/status check
router.get('/status', authMiddleware, async (c) => {
  try {
    const userRole = c.get('userRole');
    const tenantId = c.get('tenantId');
    const shopIds = c.get('shopIds') as string[];

    if (userRole !== 'admin' && userRole !== 'owner' && userRole !== 'developer') {
      return c.json({ success: false, error: 'Unauthorized' }, 403);
    }

    const latestBackup = await pool.query(
      `SELECT * FROM backup_history 
       WHERE (tenant_id = $1 OR shop_id = $2 OR ($1 IS NULL AND $2 IS NULL))
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, shopIds?.[0]]
    );

    const settings = await pool.query(
      `SELECT * FROM backup_settings 
       WHERE (tenant_id = $1 OR shop_id = $2 OR ($1 IS NULL AND $2 IS NULL))
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, shopIds?.[0]]
    );

    const cloudUrl = process.env.BACKUP_CLOUD_URL;
    const cloudSecret = process.env.BACKUP_CLOUD_SECRET;
    const shopId = shopIds?.[0];
    const key = tenantId || 'no-tenant';
    let cloudBackupsCount = 0;
    let lastCloudBackup: any = null;

    if (cloudUrl && cloudSecret) {
      try {
        const baseUrl = cloudUrl.replace(/\/api\/backup$/, '');
        const listUrl = `${baseUrl}/api/backups/${key}`;
        const response = await axios.get(listUrl, {
          headers: { 'X-Backup-Secret': cloudSecret },
          timeout: 10000,
        });
        const backups = response.data?.backups || [];
        cloudBackupsCount = backups.length;
        if (backups.length > 0) {
          lastCloudBackup = backups[0];
        }
      } catch (e: any) {
        console.error('[Backup Status] Cloud check failed:', e.message);
      }
    }

    const lastBackup = latestBackup.rows[0];
    const backupSettings = settings.rows[0];
    const now = new Date();
    const lastBackupDate = lastBackup ? new Date(lastBackup.created_at) : null;
    const hoursSinceLastBackup = lastBackupDate ? (now.getTime() - lastBackupDate.getTime()) / (1000 * 60 * 60) : null;
    const isBackupHealthy = hoursSinceLastBackup !== null && hoursSinceLastBackup < 26 && lastBackup?.status === 'completed';

    return c.json({
      success: true,
      data: {
        isEnabled: backupSettings?.is_enabled || false,
        frequency: backupSettings?.frequency || 'daily',
        lastBackup: lastBackup ? {
          id: lastBackup.id,
          filename: lastBackup.filename,
          status: lastBackup.status,
          filesize: lastBackup.filesize,
          cloud_uploaded: lastBackup.cloud_uploaded,
          created_at: lastBackup.created_at,
          hours_ago: hoursSinceLastBackup ? Math.round(hoursSinceLastBackup * 10) / 10 : null,
        } : null,
        nextBackupAt: backupSettings?.next_backup_at || null,
        cloudBackupsCount,
        lastCloudBackup: lastCloudBackup ? {
          filename: lastCloudBackup.filename,
          size_mb: lastCloudBackup.size_mb,
          created_at: lastCloudBackup.created_at,
          download_url: lastCloudBackup.download_url,
        } : null,
        isHealthy: isBackupHealthy,
        hostname: process.env.BACKUP_HOSTNAME || 'local-pc',
        key,
        cloudConfigured: !!(cloudUrl && cloudSecret),
        pendingCloudUploads: cloudBackupsCount === 0 && lastBackup && !lastBackup.cloud_uploaded ? 'Backup saved locally, waiting for internet to upload' : null,
      }
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Restore from cloud backup
router.post('/restore', authMiddleware, async (c) => {
  try {
    const userRole = c.get('userRole');
    if (userRole !== 'developer') {
      return c.json({ success: false, error: 'Only developers can restore backups' }, 403);
    }

    const { backupUrl } = await c.req.json();
    if (!backupUrl) {
      return c.json({ success: false, error: 'backupUrl is required' }, 400);
    }

    const cloudSecret = process.env.BACKUP_CLOUD_SECRET;
    if (!cloudSecret) {
      return c.json({ success: false, error: 'BACKUP_CLOUD_SECRET not configured' }, 400);
    }

    const cloudUrl = process.env.BACKUP_CLOUD_URL;
    const baseUrl = cloudUrl?.replace(/\/api\/backup$/, '') || '';

    // If backupUrl is just a filename, construct full URL
    let fullUrl = backupUrl;
    if (!backupUrl.startsWith('http')) {
      const tenantId = c.get('tenantId');
      const key = tenantId || 'no-tenant';
      fullUrl = `${baseUrl}/api/backups/${key}/${backupUrl}`;
    }

    const result = await backupService.restoreFromCloud(fullUrl, cloudSecret);

    return c.json(result);
  } catch (error: any) {
    return c.json({ success: false, message: error.message || 'Restore failed' }, 400);
  }
});

// Download backup file
router.get('/download/:id', authMiddleware, async (c) => {
  try {
    const userRole = c.get('userRole');
    const tenantId = c.get('tenantId');
    const shopIds = c.get('shopIds') as string[];
    
    if (userRole !== 'admin' && userRole !== 'owner' && userRole !== 'developer') {
      return c.json({ success: false, error: 'Unauthorized' }, 403);
    }

    const backupId = c.req.param('id');
    
    // Validate UUID format to prevent injection
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(backupId)) {
      return c.json({ success: false, error: 'Invalid backup ID format' }, 400);
    }
    
    // Get backup record and verify ownership
    const { pool } = await import('../../config/drizzle.js');
    let query = 'SELECT * FROM backup_history WHERE id = $1 AND status = $2';
    const params: any[] = [backupId, 'completed'];
    
    // Non-super-admin users can only download their own tenant/shop backups
    if (userRole !== 'developer') {
      query += ' AND (tenant_id = $3 OR shop_id = ANY($4))';
      params.push(tenantId, shopIds || []);
    }
    
    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return c.json({ success: false, error: 'Backup not found or not completed' }, 404);
    }

    const backup = result.rows[0];

    // Security: Verify the file is within allowed directory (prevent path traversal)
    const backupDir = path.join(process.cwd(), 'backups');
    const resolvedPath = path.resolve(backup.filepath);
    if (!resolvedPath.startsWith(path.resolve(backupDir))) {
      console.error('Path traversal attempt detected:', backup.filepath);
      return c.json({ success: false, error: 'Invalid backup file path' }, 403);
    }

    // Check if file exists
    if (!fs.existsSync(backup.filepath)) {
      return c.json({ success: false, error: 'Backup file not found' }, 404);
    }

    // Read file and send as downloadable
    const fileContent = fs.readFileSync(backup.filepath);
    
    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Disposition', `attachment; filename="${backup.filename}"`);
    c.header('Content-Length', backup.filesize || fileContent.length);

    return c.body(fileContent);
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// Delete backup
router.delete('/:id', authMiddleware, async (c) => {
  try {
    const userRole = c.get('userRole');
    
    if (userRole !== 'admin' && userRole !== 'owner' && userRole !== 'developer') {
      return c.json({ success: false, error: 'Unauthorized' }, 403);
    }

    const backupId = c.req.param('id');
    
    await backupService.deleteBackup(backupId);

    return c.json({ success: true, message: 'Backup deleted successfully' });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

export default router;
