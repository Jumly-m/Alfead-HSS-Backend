import { pool } from '../config/drizzle.js';
import * as ehub from './ehub-sms.service.js';

// ALFEAN ENTERPRISES's provider SMS adapter. Every send, balance check and status lookup in
// this file goes through the eHub SMS REST API (HMAC-signed, see
// ehub-sms.service.ts). These exported function shapes are the internal contract
// used by all callers (sms.service.ts, routes, jobs), so they should remain
// stable.

async function logSmsEvent(tenantId: string | null, phone: string, message: string, status: string, batchId?: string, messageId?: string, errorMsg?: string) {
  try {
    await pool.query(
      `INSERT INTO sms_log (tenant_id, phone, message, status, batch_id, message_id, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, phone, message, status, batchId || null, messageId || null, errorMsg || null]
    );
  } catch (e: any) {
    console.error('[SMS Log] Failed to log:', e.message);
  }
}

function normalizePhone(phone: string): string {
  const cleaned = String(phone || '').replace(/^\+/, '').replace(/[^0-9]/g, '');
  if (cleaned.startsWith('0')) return `255${cleaned.slice(1)}`;
  // Bare 9-digit TZ mobile (e.g. 668793139) → prefix 255 so valid numbers that
  // lost their leading 0 still deliver instead of failing as "invalid".
  if (cleaned.length === 9 && /^[67]/.test(cleaned)) return `255${cleaned}`;
  return cleaned;
}

export async function sendSms(phone: string, message: string, tenantId?: string): Promise<{ success: boolean; batchId?: string; messageIds?: string[]; error?: string }> {
  if (!ehub.isEhubConfigured()) {
    console.warn('[SMS] eHub SMS not configured, skipping SMS to', phone);
    await logSmsEvent(tenantId || null, phone, message, 'failed', undefined, undefined, 'eHub SMS not configured');
    return { success: false, error: 'eHub SMS not configured' };
  }

  const formattedPhone = normalizePhone(phone);
  if (!formattedPhone.startsWith('255') || formattedPhone.length !== 12) {
    const err = `Invalid Tanzanian phone: ${phone}`;
    console.warn('[SMS]', err);
    await logSmsEvent(tenantId || null, phone, message, 'failed', undefined, undefined, err);
    return { success: false, error: err };
  }

  try {
    const senderId = await ehub.getPrimarySenderId();
    const result = await ehub.sendSingleSms(formattedPhone, message, senderId);
    const messageId = result?.message_id ?? result?.id ?? result?.messageId ?? null;
    console.log(`[SMS] Sent to ${formattedPhone}, messageId: ${messageId}`);
    await logSmsEvent(tenantId || null, formattedPhone, message, 'queued', messageId || undefined, messageId);
    return { success: true, batchId: messageId || undefined, messageIds: messageId ? [messageId] : [] };
  } catch (e: any) {
    console.error('[SMS] Error:', e.message);
    await logSmsEvent(tenantId || null, formattedPhone, message, 'failed', undefined, undefined, e.message);
    return { success: false, error: e.message };
  }
}

export async function sendBulkSms(phones: string[], message: string): Promise<{ success: boolean; batchId?: string; queued?: number; errors?: string[] }> {
  if (!ehub.isEhubConfigured()) return { success: false, errors: ['eHub SMS not configured'] };

  const normalizedPhones = [...new Set(phones.map(p => {
    const cleaned = String(p || '').replace(/^\+/, '').replace(/[^0-9]/g, '');
    return cleaned.startsWith('0') ? `255${cleaned.slice(1)}` : cleaned;
  }).filter(p => p.startsWith('255') && p.length === 12))];

  if (normalizedPhones.length === 0) {
    return { success: false, errors: ['No valid Tanzanian phone numbers'] };
  }

  try {
    const senderId = await ehub.getPrimarySenderId();
    // eHub caps a single bulk request at 1,000 recipients (docs). Split larger
    // batches into chunks so large campaigns are never rejected outright.
    const CHUNK = 1000;
    const batchIds: string[] = [];
    let sent = 0;
    const errors: string[] = [];
    for (let i = 0; i < normalizedPhones.length; i += CHUNK) {
      const chunk = normalizedPhones.slice(i, i + CHUNK);
      try {
        const result = await ehub.sendBulkSms(chunk, message, senderId);
        const id = result?.id ?? result?.batch_id;
        if (id) batchIds.push(id);
        sent += chunk.length;
      } catch (e: any) {
        errors.push(String(e.message || 'Bulk chunk failed'));
      }
    }
    console.log(`[SMS] Bulk sent to ${sent}/${normalizedPhones.length} recipients, batchIds: ${batchIds.length}`);
    return { success: sent > 0, batchId: batchIds[0], queued: sent, errors: errors.length ? errors : undefined };
  } catch (e: any) {
    console.error('[SMS] Bulk error:', e.message);
    return { success: false, errors: [e.message] };
  }
}

export async function checkBalance(): Promise<{ success: boolean; balance?: number; raw?: any; error?: string }> {
  if (!ehub.isEhubConfigured()) return { success: false, error: 'eHub SMS not configured' };

  try {
    const balance = await ehub.getWalletBalance();
    return { success: true, balance: Number(balance) || 0, raw: { balance } };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

export async function checkMessageStatus(messageId: string): Promise<{ success: boolean; status?: string; deliveredAt?: string; error?: string }> {
  try {
    const data = await ehub.getMessageStatus(messageId);
    return {
      success: true,
      status: data?.status,
      deliveredAt: data?.delivered_at ?? data?.deliveredAt,
    };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}
