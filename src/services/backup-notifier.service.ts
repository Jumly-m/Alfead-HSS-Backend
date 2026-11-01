import { pool } from "../config/drizzle.js";
import axios from "axios";

export interface Notifier {
  id: string;
  name: string;
  type: string;
  webhookUrl: string;
  method: string;
  headers: Record<string, string>;
  bodyTemplate: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface BackupStatus {
  id: string;
  heading: string | null;
  message: string | null;
  status: string;
  receivedAt: Date;
  createdAt: Date;
}

export const getNotifiers = async (): Promise<Notifier[]> => {
  const result = await pool.query(
    `SELECT id, name, type, webhook_url as "webhookUrl", method, headers, body_template as "bodyTemplate", is_active as "isActive", created_at as "createdAt", updated_at as "updatedAt"
     FROM notifiers ORDER BY created_at ASC`
  );
  return result.rows.map((row: any) => ({ ...row, headers: typeof row.headers === 'string' ? JSON.parse(row.headers) : row.headers }));
};

export const createNotifier = async (data: {
  name: string;
  type?: string;
  webhookUrl: string;
  method?: string;
  headers?: Record<string, string>;
  bodyTemplate?: string;
  isActive?: boolean;
}): Promise<Notifier> => {
  const result = await pool.query(
    `INSERT INTO notifiers (name, type, webhook_url, method, headers, body_template, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, name, type, webhook_url as "webhookUrl", method, headers, body_template as "bodyTemplate", is_active as "isActive", created_at as "createdAt", updated_at as "updatedAt"`,
    [
      data.name,
      data.type || 'webhook',
      data.webhookUrl,
      data.method || 'POST',
      JSON.stringify(data.headers || {}),
      data.bodyTemplate || '{"heading":"{{heading}}","message":"{{message}}","timestamp":"{{now}}"}',
      data.isActive !== false,
    ]
  );
  return result.rows[0];
};

export const updateNotifier = async (
  id: string,
  data: Partial<{
    name: string;
    type: string;
    webhookUrl: string;
    method: string;
    headers: Record<string, string>;
    bodyTemplate: string;
    isActive: boolean;
  }>
): Promise<Notifier | null> => {
  const current = await pool.query(`SELECT * FROM notifiers WHERE id = $1`, [id]);
  if (current.rows.length === 0) return null;

  const merged = current.rows[0];
  const result = await pool.query(
    `UPDATE notifiers SET
       name = $1, type = $2, webhook_url = $3, method = $4, headers = $5,
       body_template = $6, is_active = $7, updated_at = NOW()
     WHERE id = $8
     RETURNING id, name, type, webhook_url as "webhookUrl", method, headers, body_template as "bodyTemplate", is_active as "isActive", created_at as "createdAt", updated_at as "updatedAt"`,
    [
      data.name ?? merged.name,
      data.type ?? merged.type,
      data.webhookUrl ?? merged.webhook_url,
      data.method ?? merged.method,
      JSON.stringify(data.headers ?? merged.headers),
      data.bodyTemplate ?? merged.body_template,
      data.isActive ?? merged.is_active,
      id,
    ]
  );
  return result.rows[0];
};

export const deleteNotifier = async (id: string): Promise<boolean> => {
  const result = await pool.query(`DELETE FROM notifiers WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
};

const getLatestBackupStatusRow = async (): Promise<BackupStatus | null> => {
  const result = await pool.query(
    `SELECT id, heading, message, status, received_at as "receivedAt", created_at as "createdAt"
     FROM backup_status ORDER BY received_at DESC LIMIT 1`
  );
  return result.rows[0] || null;
};

export const getBackupStatus = async (): Promise<BackupStatus | null> => {
  return getLatestBackupStatusRow();
};

export const getBackupStatusHistory = async (limit = 20): Promise<BackupStatus[]> => {
  const result = await pool.query(
    `SELECT id, heading, message, status, received_at as "receivedAt", created_at as "createdAt"
     FROM backup_status ORDER BY received_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
};

export const recordBackupStatus = async (data: {
  heading?: string;
  message?: string;
  status?: string;
  receivedAt?: Date;
}): Promise<BackupStatus> => {
  const heading = (data.heading || '').trim();
  const message = (data.message || '').trim();
  const status = data.status || inferBackupStatus(heading, message);
  const result = await pool.query(
    `INSERT INTO backup_status (heading, message, status, received_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id, heading, message, status, received_at as "receivedAt", created_at as "createdAt"`,
    [heading || null, message || null, status, data.receivedAt || new Date()]
  );
  return result.rows[0];
};

export const inferBackupStatus = (heading: string, message: string): string => {
  const text = `${heading} ${message}`.toLowerCase();
  if (/fail|error|unsuccess|failed to|exception/.test(text)) return 'failed';
  if (/success|completed|completed successfully|done|ok/.test(text)) return 'success';
  if (/start|running|progress|pending|uploading/.test(text)) return 'running';
  return 'unknown';
};

export const renderTemplate = (
  template: string,
  vars: Record<string, string>
): string => {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
};

const normalizeHeaders = (headers: Record<string, string> | string): Record<string, string> => {
  if (typeof headers === 'string') {
    try {
      const parsed = JSON.parse(headers);
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }
  return headers || {};
};

export const sendToNotifier = async (
  notifier: Notifier,
  payload: { heading: string; message: string }
): Promise<{ ok: boolean; response: string }> => {
  const heading = payload.heading || '';
  const message = payload.message || '';
  const bodyTemplate = notifier.bodyTemplate || '{"heading":"{{heading}}","message":"{{message}}"}';
  const now = new Date().toISOString();

  let body: any;
  const rendered = renderTemplate(bodyTemplate, { heading, message, now });
  try {
    body = JSON.parse(rendered);
  } catch {
    body = rendered;
  }

  const headers = normalizeHeaders(notifier.headers);
  const method = (notifier.method || 'POST').toUpperCase();
  const url = renderTemplate(notifier.webhookUrl, { heading, message, now });

  try {
    if (method === 'GET') {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(typeof body === 'object' ? body : {})) {
        params.append(k, String(v));
      }
      const separator = url.includes('?') ? '&' : '?';
      const target = `${url}${separator}${params.toString()}`;
      await axios.get(target, { headers, timeout: 15000 });
    } else if (method === 'PUT') {
      await axios.put(url, body, { headers, timeout: 15000 });
    } else {
      await axios.post(url, body, { headers, timeout: 15000 });
    }
    return { ok: true, response: '200 OK' };
  } catch (e: any) {
    const detail = e?.response ? `${e.response.status} ${JSON.stringify(e.response.data)?.slice(0, 500)}` : e?.message;
    return { ok: false, response: detail || 'Unknown error' };
  }
};

export const logNotifierDelivery = async (data: {
  notifierId: string;
  heading?: string;
  message?: string;
  status: string;
  response?: string;
}): Promise<void> => {
  try {
    await pool.query(
      `INSERT INTO notifier_log (notifier_id, heading, message, status, response)
       VALUES ($1, $2, $3, $4, $5)`,
      [data.notifierId, data.heading || null, data.message || null, data.status, data.response || null]
    );
  } catch (e) {
    console.error('[Notifier] Failed to log delivery:', e);
  }
};

// Store a received backup status, then dispatch to all active notifiers.
export const receiveBackupStatus = async (data: {
  heading?: string;
  message?: string;
  status?: string;
  receivedAt?: Date;
}): Promise<{ status: BackupStatus; deliveries: { notifier: string; ok: boolean; response: string }[] }> => {
  const status = await recordBackupStatus(data);

  const notifiers = await getNotifiers();
  const active = notifiers.filter((n) => n.isActive);

  const deliveries: { notifier: string; ok: boolean; response: string }[] = [];
  for (const notifier of active) {
    const result = await sendToNotifier(notifier, {
      heading: status.heading || 'ALFEAN ENTERPRISES Backup Status',
      message: status.message || '',
    });
    await logNotifierDelivery({
      notifierId: notifier.id,
      heading: status.heading || undefined,
      message: status.message || undefined,
      status: result.ok ? 'sent' : 'failed',
      response: result.response,
    });
    deliveries.push({ notifier: notifier.name, ok: result.ok, response: result.response });
  }

  return { status, deliveries };
};

// Send a manual test notification to a single notifier (does not touch backup_status).
export const testNotifier = async (notifierId: string): Promise<{ ok: boolean; response: string } | null> => {
  const result = await pool.query(`SELECT * FROM notifiers WHERE id = $1`, [notifierId]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  const notifier: Notifier = {
    ...row,
    webhookUrl: row.webhook_url,
    bodyTemplate: row.body_template,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  const res = await sendToNotifier(notifier, {
    heading: 'ALFEAN ENTERPRISES Test Notification',
    message: 'This is a test notification from ALFEAN ENTERPRISES Backup Notifier.',
  });
  await logNotifierDelivery({
    notifierId,
    heading: 'ALFEAN ENTERPRISES Test Notification',
    message: 'This is a test notification from ALFEAN ENTERPRISES Backup Notifier.',
    status: res.ok ? 'sent' : 'failed',
    response: res.response,
  });
  return res;
};

export const getWebhookConfig = async (): Promise<{
  webhookUrl: string;
  hasSecret: boolean;
  baseUrl: string;
}> => {
  const secretRes = await pool.query(`SELECT value FROM system_settings WHERE key = 'backup_webhook_secret'`);
  const secret = secretRes.rows[0]?.value;
  const envSecret = process.env.BACKUP_WEBHOOK_SECRET;
  const baseUrl = process.env.APP_URL || process.env.PUBLIC_URL || process.env.CORS_ORIGIN || '';
  return {
    webhookUrl: `${baseUrl.replace(/\/$/, '')}/api/backup-notifications`,
    hasSecret: !!(secret || envSecret),
    baseUrl,
  };
};

export const getWebhookSecret = async (): Promise<string> => {
  const secretRes = await pool.query(`SELECT value FROM system_settings WHERE key = 'backup_webhook_secret'`);
  const dbSecret = secretRes.rows[0]?.value;
  if (dbSecret) return typeof dbSecret === 'string' ? dbSecret : JSON.stringify(dbSecret);
  return process.env.BACKUP_WEBHOOK_SECRET || '';
};

export const setWebhookSecret = async (secret: string): Promise<void> => {
  await pool.query(
    `INSERT INTO system_settings (key, value) VALUES ('backup_webhook_secret', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [secret]
  );
};

// Verify the incoming webhook header against the configured secret.
export const verifyWebhookSecret = async (provided: string | undefined | null): Promise<boolean> => {
  const expected = await getWebhookSecret();
  if (!expected) return false;
  if (!provided) return false;
  // Constant-ish time comparison
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
};

export const getNotifierLogs = async (limit = 20): Promise<any[]> => {
  const result = await pool.query(
    `SELECT nl.id, nl.notifier_id as "notifierId", nl.heading, nl.message, nl.status, nl.response, nl.created_at as "createdAt", n.name as "notifierName"
     FROM notifier_log nl
     LEFT JOIN notifiers n ON n.id = nl.notifier_id
     ORDER BY nl.created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
};
