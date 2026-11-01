import cron from 'node-cron';
import pkg from 'pg';
const { Pool } = pkg;
import { sendBulkSms } from '../services/ehub-sms-adapter.service.js';
import { isSmsAutomationEnabled } from '../services/sms-automation.service.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export function startSmsCampaignCron() {
  // Check for scheduled campaigns every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    if (!(await isSmsAutomationEnabled('scheduled_campaigns'))) return; // paused by developer
    console.log('[cron] Checking scheduled SMS campaigns...');
    try {
      const result = await pool.query(`
        SELECT * FROM sms_campaigns
        WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()
        LIMIT 5
      `);

      for (const campaign of result.rows) {
        console.log(`[cron] Sending campaign: ${campaign.id} - ${campaign.title}`);

        let phones: string[] = [];
        if (campaign.recipient_type === 'all' || campaign.recipient_type === 'non_paying') {
          const r = await pool.query(`
            SELECT DISTINCT COALESCE(u.phone, t.phone) as phone FROM tenants t
            LEFT JOIN "user" u ON u.tenant_id = t.id::text AND u.role IN ('admin','owner')
            WHERE (u.phone IS NOT NULL OR t.phone IS NOT NULL)
              AND ${campaign.recipient_type === 'non_paying' ? `NOT EXISTS (SELECT 1 FROM tenant_subscriptions ts WHERE ts.tenant_id = t.id AND ts.status = 'active' AND ts.current_period_end > NOW())` : '1=1'}
          `);
          phones = r.rows.map((row: any) => row.phone).filter(Boolean);
        } else if (campaign.recipient_type === 'trial_expiring') {
          const r = await pool.query(`
            SELECT DISTINCT COALESCE(u.phone, t.phone) as phone FROM tenants t
            LEFT JOIN "user" u ON u.tenant_id = t.id::text AND u.role IN ('admin','owner')
            WHERE (u.phone IS NOT NULL OR t.phone IS NOT NULL)
              AND t.trial_activated = true AND t.trial_end > NOW() AND t.trial_end <= NOW() + INTERVAL '7 days'
          `);
          phones = r.rows.map((row: any) => row.phone).filter(Boolean);
        }

        if (phones.length === 0) {
          await pool.query(`UPDATE sms_campaigns SET status = 'failed' WHERE id = $1`, [campaign.id]);
          continue;
        }

        const smsResult = await sendBulkSms(phones, campaign.message);
        await pool.query(`
          UPDATE sms_campaigns SET status = $1, sent_count = $2, failed_count = $3, sent_at = NOW()
          WHERE id = $4
        `, [
          smsResult.success ? 'sent' : 'failed',
          smsResult.queued || 0,
          smsResult.success ? 0 : phones.length,
          campaign.id
        ]);
      }

      if (result.rows.length > 0) {
        console.log(`[cron] Processed ${result.rows.length} campaign(s)`);
      }
    } catch (e: any) {
      console.error('[cron] SMS campaign scheduler error:', e.message);
    }
  });

  console.log('[cron] SMS campaign scheduler registered (every 5 min)');
}
