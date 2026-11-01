import cron from 'node-cron';
import { pool } from '../config/drizzle.js';
import * as reseller from '../services/sms-reseller.service.js';

function nextOccurrence(current: Date, recurrence: string): Date | null {
  const next = new Date(current.getTime());
  if (recurrence === 'daily') {
    next.setDate(next.getDate() + 1);
  } else if (recurrence === 'weekly') {
    next.setDate(next.getDate() + 7);
  } else if (recurrence === 'monthly') {
    next.setMonth(next.getMonth() + 1);
  } else {
    return null;
  }
  return next;
}

export function startUserSmsCampaignCron() {
  cron.schedule('*/5 * * * *', async () => {
    console.log('[cron] Checking scheduled user SMS campaigns...');
    try {
      const result = await pool.query(`
        SELECT * FROM sms_user_campaigns
        WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()
        LIMIT 5
      `);

      for (const campaign of result.rows) {
        console.log(`[cron] Sending user campaign: ${campaign.id} - ${campaign.name}`);
        try {
          await reseller.sendUserCampaignNow(campaign.shop_id, campaign.id);

          if (campaign.type === 'recurring' && campaign.recurrence) {
            const next = nextOccurrence(new Date(campaign.scheduled_at), campaign.recurrence);
            if (next) {
              await pool.query(
                `UPDATE sms_user_campaigns SET status = 'scheduled', scheduled_at = $2, sent_at = NULL WHERE id = $1`,
                [campaign.id, next]
              );
            }
          }
        } catch (e: any) {
          console.error(`[cron] User campaign ${campaign.id} failed:`, e.message);
        }
      }
    } catch (e: any) {
      console.error('[cron] User SMS campaign scheduler error:', e.message);
    }
  });

  console.log('[cron] User SMS campaign scheduler registered (every 5 min)');
}
