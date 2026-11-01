import { Hono } from 'hono';
import { verifyWebhookSecret, receiveBackupStatus } from '../../services/backup-notifier.service.js';

// Public webhook receiver for Databasus backup notifications.
// This route must NOT require auth — Databasus calls it over the internet.
const router = new Hono();

router.post('/', async (c) => {
  const provided = c.req.header('x-webhook-secret') || c.req.header('X-Webhook-Secret') || null;
  const valid = await verifyWebhookSecret(provided);

  if (!valid) {
    console.warn('[Backup Notifier] Rejected webhook with invalid/missing secret');
    return c.json({ error: 'Invalid webhook secret' }, 401);
  }

  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    // fall through with empty body
  }

  const heading = body?.heading || body?.title || '';
  const message = body?.message || body?.body || '';
  const receivedAt = body?.timestamp ? new Date(body.timestamp) : undefined;

  if (!heading && !message) {
    return c.json({ error: 'heading or message is required' }, 400);
  }

  try {
    const { deliveries } = await receiveBackupStatus({ heading, message, receivedAt });
    console.log(`[Backup Notifier] Received status "${heading}" → dispatched to ${deliveries.length} notifier(s)`);
    return c.json({ received: true, deliveries: deliveries.length });
  } catch (e: any) {
    console.error('[Backup Notifier] Failed to process webhook:', e?.message);
    return c.json({ error: 'Failed to process notification' }, 500);
  }
});

export default router;
