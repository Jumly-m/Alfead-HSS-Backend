/**
 * Bridges the daily AI blog article and the daily marketing email.
 *
 * ONE topic per day: the blog article is the advanced, detailed version; the
 * email (to tenants and to the developer) carries only the key points with a
 * "Soma zaidi kuelewa zaidi" button — so the same subject never produces two
 * different emails, and the AI cost is paid once.
 *
 * Depends on `pool` only (no imports from email.service or blog.routes) to keep
 * the module graph acyclic.
 */
import { pool } from '../config/drizzle.js';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:47831';

/** Pulls up to `max` key points from the article HTML: list items first, then headings. */
export function blogKeyPoints(html: string, max = 4): string[] {
  const source = String(html || '');
  const extract = (re: RegExp) => {
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) out.push(m[1]);
    return out;
  };
  const clean = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  let points = extract(/<li[^>]*>([\s\S]*?)<\/li>/gi).map(clean).filter((p) => p.length >= 20);
  if (points.length < 2) points = extract(/<h2[^>]*>([\s\S]*?)<\/h2>/gi).map(clean).filter((p) => p.length >= 12);
  if (points.length < 2) points = extract(/<h3[^>]*>([\s\S]*?)<\/h3>/gi).map(clean).filter((p) => p.length >= 12);

  return points.slice(0, max).map((p) => (p.length > 140 ? p.slice(0, 137) + '…' : p));
}

/** Today's (last 26h) latest published article → ready-to-send marketing email. */
export async function getTodayBlogMarketing(): Promise<{ subject: string; html: string; slug: string; title: string } | null> {
  try {
    const r = await pool.query(`
      SELECT slug, title, excerpt, meta_description, content_html, cover_image, published_at
      FROM blog_posts
      WHERE status = 'published' AND published_at > NOW() - INTERVAL '26 hours'
      ORDER BY published_at DESC LIMIT 1
    `);
    if (r.rows.length === 0) return null;
    const post = r.rows[0];

    return {
      subject: `💡 ${post.title}`,
      html: buildBlogEmailHtml(post, { personalized: true, forDeveloper: false }),
      slug: post.slug,
      title: post.title,
    };
  } catch (e: any) {
    console.warn('[BlogMarketing] Could not build marketing email:', e.message);
    return null;
  }
}

/**
 * Professional, fully-INLINE (no <style> tags), table-based blog email.
 * Works in Gmail/Outlook/Apple Mail on desktop and phones. Used for BOTH the
 * developer notification and the daily tenant "Tip ya Leo" email.
 */
export function buildBlogEmailHtml(
  post: { slug: string; title: string; excerpt?: string; content_html: string; published_at?: string; tags?: string; cover_image?: string },
  opts: { personalized?: boolean; forDeveloper?: boolean } = {}
): string {
  const url = `${APP_URL}/blog/${post.slug}`;
  const points = blogKeyPoints(post.content_html, 4);
  const dateLabel = (post.published_at ? new Date(post.published_at) : new Date())
    .toLocaleDateString('sw-TZ', { day: '2-digit', month: 'long', year: 'numeric' });
  const greeting = opts.personalized ? 'Habari <strong>{{name}}</strong>, ' : '';
  const excerpt = String(post.excerpt || '').trim();
  const tagChips = String(post.tags || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((t) => `<span style="display:inline-block;background:#ecfdf5;color:#047857;font-size:11px;font-weight:700;padding:4px 10px;border-radius:20px;margin:0 6px 6px 0;">${t}</span>`)
    .join('');

  const pointRows = points.map((p, i) => `
    <tr>
      <td width="34" valign="top" style="padding:0 10px 12px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="24" height="24" align="center" valign="middle" bgcolor="#047857" style="width:24px;height:24px;border-radius:12px;color:#ffffff;font-size:12px;font-weight:bold;font-family:Arial,sans-serif;">${i + 1}</td>
        </tr></table>
      </td>
      <td valign="top" style="padding:0 0 12px;font-size:14px;line-height:1.65;color:#334155;font-family:Arial,Helvetica,sans-serif;">${p}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="sw">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<title>${post.title}</title>
</head>
<body style="margin:0;padding:0;background-color:#f2f5f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2f5f7;">
    <tr><td align="center" style="padding:28px 12px;">

      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #e4e9f0;border-radius:16px;overflow:hidden;">

        <!-- Brand bar -->
        <tr><td bgcolor="#047857" style="background-color:#047857;padding:18px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td valign="middle" style="font-family:Arial,Helvetica,sans-serif;">
              <img src="${APP_URL}/logo.png" width="34" height="34" alt="ALFEAN ENTERPRISES" style="display:inline-block;vertical-align:middle;border-radius:8px;background:#ffffff;" />
              <span style="display:inline-block;vertical-align:middle;margin-left:10px;color:#ffffff;font-size:17px;font-weight:bold;letter-spacing:0.3px;">ALFEAN ENTERPRISES</span>
              <span style="display:inline-block;vertical-align:middle;margin-left:8px;color:#a7f3d0;font-size:11.5px;">Mfumo wa Mauzo Tanzania</span>
            </td>
            <td align="right" valign="middle" style="font-family:Arial,Helvetica,sans-serif;color:#d1fae5;font-size:11.5px;white-space:nowrap;">${dateLabel}</td>
          </tr></table>
        </td></tr>
        <!-- Accent strip -->
        <tr><td height="4" bgcolor="#10b981" style="background-color:#10b981;height:4px;line-height:4px;font-size:0;">&nbsp;</td></tr>

        <!-- Body -->
        <tr><td style="padding:28px 28px 6px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="font-family:Arial,Helvetica,sans-serif;padding-bottom:10px;">
              <span style="display:inline-block;background-color:#ecfdf5;color:#047857;font-size:11px;font-weight:bold;letter-spacing:1px;padding:5px 12px;border-radius:20px;text-transform:uppercase;">${opts.forDeveloper ? '📝 Makala Mpya ya Blog' : '💡 Tip ya Leo'}</span>
            </td></tr>
            <tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:22px;line-height:1.35;font-weight:bold;color:#0f172a;padding-bottom:12px;">
              ${post.title}
            </td></tr>
            ${excerpt ? `<tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.7;color:#475569;padding-bottom:16px;">${greeting}${excerpt}</td></tr>` : ''}
            ${tagChips ? `<tr><td style="padding-bottom:14px;">${tagChips}</td></tr>` : ''}
          </table>
        </td></tr>

        ${points.length > 0 ? `
        <!-- Key points -->
        <tr><td style="padding:4px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f0fdf4;border:1px solid #d1fae5;border-radius:14px;">
            <tr><td style="padding:18px 20px 8px;">
              <p style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;color:#065f46;letter-spacing:1px;text-transform:uppercase;">Mambo muhimu ya leo</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${pointRows}</table>
            </td></tr>
          </table>
        </td></tr>` : ''}

        <!-- CTA -->
        <tr><td align="center" style="padding:26px 28px 8px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td align="center" bgcolor="#10b981" style="background-color:#10b981;border-radius:12px;">
              <a href="${url}" target="_blank" style="display:inline-block;padding:15px 34px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;">Soma zaidi kuelewa zaidi →</a>
            </td>
          </tr></table>
          <p style="margin:12px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#94a3b8;">Makala kamili ina hatua kwa hatua, mifano ya TZS na makosa ya kuepuka.</p>
          ${opts.forDeveloper ? `
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;"><tr>
            <td align="center" bgcolor="#f1f5f9" style="background-color:#f1f5f9;border:1px solid #e2e8f0;border-radius:10px;">
              <a href="${APP_URL}/developer" target="_blank" style="display:inline-block;padding:11px 24px;font-family:Arial,Helvetica,sans-serif;font-size:12.5px;font-weight:bold;color:#0f172a;text-decoration:none;">✍️ Badilisha / Hariri</a>
            </td>
          </tr></table>` : ''}
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 28px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td height="1" bgcolor="#eef2f6" style="height:1px;line-height:1px;font-size:0;">&nbsp;</td></tr>
            <tr><td align="center" style="padding-top:16px;font-family:Arial,Helvetica,sans-serif;font-size:11.5px;line-height:1.7;color:#94a3b8;">
              ALFEAN ENTERPRISES — Mfumo wa Mauzo &amp; Usimamizi wa Duka · Tanzania<br/>
              <a href="${APP_URL}/dashboard" target="_blank" style="color:#059669;text-decoration:none;font-weight:bold;">Dashboard</a>
            </td></tr>
          </table>
        </td></tr>

      </table>

      <p style="margin:14px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:10.5px;color:#b6c2cf;">Umetumiwa na ALFEAN ENTERPRISES kwa sababu unatumia mfumo wa ALFEAN ENTERPRISES POS.</p>
    </td></tr>
  </table>
</body>
</html>`;
}
