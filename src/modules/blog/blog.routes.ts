/**
 * ALFEAN ENTERPRISES Blog — AI-operated, isolated.
 *
 * • Public:     GET /api/blog            → published posts (paginated)
 *               GET /api/blog/:slug      → single post (+view counter)
 *               GET /api/blog/sitemap.xml→ XML sitemap for search engines
 * • Developer:  GET/POST/PUT/DELETE /api/dev-blog ...
 *               POST /api/dev-blog/generate  → AI writes today's article now
 *
 * The blog lives in its OWN tables (blog_posts, blog_state) so it can never
 * slow down the main POS system, and every query is small + indexed.
 *
 * A daily cron (07:00 EAT) asks DeepSeek for a detailed, practical article
 * about one ALFEAN ENTERPRISES feature (rotating topics), publishes it, and emails the
 * developer a preview with an edit link.
 */
import { Hono } from 'hono';
import { pool } from '../../config/drizzle.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { sendEmail } from '../../services/email.service.js';
import { blogKeyPoints, buildBlogEmailHtml } from '../../services/blog-marketing.service.js';
import cron from 'node-cron';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:47831';

// ─── Topics (rotates one per day; never runs out) ────────────────────────────

const BLOG_TOPICS = [
  'Jinsi ya kufanya mauzo (POS) haraka — hatua kwa hatua kwa duka la Tanzania',
  'Jinsi ya kurekodi matumizi (expenses) na kujua faida halisi ya duka',
  'Jinsi ya kusimamia madeni ya wateja na kukusanya malipo kwa wakati',
  'Jinsi ya kusimamia bidhaa na stock: kuongeza bidhaa, kubadilisha bei na low-stock alerts',
  'Jinsi ya kutumia ripoti (reports) kujua bidhaa zinazouza zaidi na faida ya mwezi',
  'Jinsi ya kutuma SMS kwa wateja: matangazo, ukumbusho wa madeni na ofa',
  'Jinsi ya kutumia ankara (invoices) na kufuatilia malipo ya wateja',
  'Jinsi ya kutumia pre-orders kwa bidhaa zisizopo stock',
  'Jinsi ya kusimamia huduma (services) na mapato yake',
  'Jinsi ya kutumia maduka mengi (shops) na wauzaji (users) kwa usalama wa data',
  'Jinsi ya kufanya stock take (hesabu ya bidhaa) bila kufunga duka',
  'Jinsi ya kutumia taarifa za wateja (customers) kuongeza mauzo ya kurudia',
  'Jinsi ya kutumia AI Advisor kupata ushauri wa biashara yako',
  'Jinsi ya kutumia referral (Alika Rafiki) kupata commission ya 10%',
  'Jinsi ya kutumia kuponi na ofa kuvutia wateja wapya',
  'Jinsi ya kuhakikisha data yako iko salama: backup na usalama wa akaunti',
];

// ─── Schema (isolated blog tables) ───────────────────────────────────────────

export async function ensureBlogTables(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS blog_posts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug VARCHAR(220) UNIQUE NOT NULL,
        title TEXT NOT NULL,
        excerpt TEXT,
        content_html TEXT NOT NULL,
        cover_image TEXT,
        tags TEXT,
        meta_description TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'draft',
        source VARCHAR(20) NOT NULL DEFAULT 'ai',
        ai_topic TEXT,
        views INTEGER NOT NULL DEFAULT 0,
        published_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS blog_posts_status_pub_idx ON blog_posts (status, published_at DESC)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS blog_state (
      key VARCHAR(50) PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
    console.log('✅ Blog tables ready');
  } catch (e: any) {
    console.log('⚠️  Blog tables check:', e.message);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 180);
}

// Very light sanitation: keep the article's formatting tags, drop scripts and
// event handlers (content is AI-generated + editor-authored, but be safe).
function sanitizeHtml(html: string): string {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}

const stripTags = (html: string) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// LLM JSON is often *almost* valid: markdown fences, prose around the object,
// and raw newlines/tabs inside string values. This recovers all three.
function safeParseJson(text: string): any | null {
  let s = String(text || '').replace(/^```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  s = s.slice(start, end + 1);

  const tryParse = (v: string) => { try { return JSON.parse(v); } catch { return null; } };
  const direct = tryParse(s);
  if (direct) return direct;

  // Escape raw control characters ONLY inside string literals.
  let out = '';
  let inStr = false, esc = false;
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (code < 32) { out += '\\u' + code.toString(16).padStart(4, '0'); continue; }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  const repaired = tryParse(out);
  if (repaired) return repaired;

  // Last resort: truncated response → close any open string/object minimally.
  const closed = out + (inStr ? '"' : '') + (out.trimEnd().endsWith('}') ? '' : '}');
  return tryParse(closed);
}

// ─── AI generation ───────────────────────────────────────────────────────────

async function nextTopic(): Promise<string> {
  try {
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM blog_posts`);
    const n = Number(r.rows[0]?.n) || 0;
    return BLOG_TOPICS[n % BLOG_TOPICS.length];
  } catch {
    return BLOG_TOPICS[0];
  }
}

async function generateArticle(topic: string): Promise<any | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.warn('[Blog] DEEPSEEK_API_KEY not set — skipping generation');
    return null;
  }
  const system = `You are the official ALFEAN ENTERPRISES POS instructor and blog writer (127.0.0.1:47831) — a Tanzanian POS & business management system used by hardware stores and shops.
Your ONLY job is to TEACH ALFEAN ENTERPRISES POS USERS how to use the system's features — never generic business advice. Every article is a practical, step-by-step tutorial for a real ALFEAN ENTERPRISES feature.

The ALFEAN ENTERPRISES system menu (use these EXACT names when giving instructions):
- Dashboard: Utendaji wa Leo (Mauzo ya Leo, Faida, Oda, Matumizi, Madeni), Muhtasari wa Biashara, Mlinganisho wa Miezi, Vidokezo vya Biashara, AI Advisor.
- POS (Uza): tafuta/kuchagua bidhaa, kikapu, bei, punguzo, kiasi (pcs/kg/mita), njia za malipo (Cash, Lipa Namba, Deni/Mkopo, malipo mchanganyiko), risiti inachapishwa.
- Bidhaa: kuongeza bidhaa (jina, barcode, kategoria, bei ya kuuza, bei ya kununua/buying price, stock, kikomo cha chini/low stock), vitengo (Units), kategoria.
- Mauzo: orodha ya mauzo yote, ankara, kuchuja kwa tarehe/njia ya malipo, kuangalia faida ya kila mauzo.
- Wateja: kuongeza mteja (jina + namba ya simu LAZIMA), historia ya manunuzi, mteja anayedaiwa.
- Madeni: kuongeza deni, malipo ya awamu (partial payments), kumbusho la SMS kwa wadaiwa, kufuatilia salio.
- Matumizi: kuongeza matumizi kwa kategoria (Kodi, Umeme, Mishahara, Usafiri...), ripoti ya matumizi.
- Ripoti: faida, bidhaa zinazouza zaidi, mauzo kwa njia ya malipo, mauzo kwa mwezi, kuhamisha (export) PDF/Excel.
- Huduma: kurekodi huduma (services) na mapato yake.
- Ankara: kutengeneza ankara, kufuatilia malipo (invoice payments).
- Pre-orders: kuagiza bidhaa kwa mteja na kufuatilia malipo kabla ya kuitoa.
- Stock Take: hesabu ya bidhaa (stock take) na tofauti zake.
- SMS Center: kutuma SMS kwa wateja, historia ya SMS, sender ID, Bulk SMS, matangazo.
- AI Advisor: ushauri wa AI kwenye dashboard (uchambuzi wa mauzo, bidhaa zisizouza, ushauri wa biashara).
- Usajili na Malipo: kuendesha usajili (package), kuponi za punguzo, malipo ya mapema (renewal), Lipa Namba fallback.
- Alika Rafiki: referral — kushiriki link na kupata commission 10%.
- Wasambazaji: suppliers, Wauzaji/Watumiaji: users & permissions, Maduka: multi-shop, Backup: kunakili data.

Writing rules:
- content_html uses ONLY: <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <blockquote>.
- 900–1300 words. Structure: short intro → "Kwa nini kipengele hiki ni muhimu" → step-by-step numbered instructions using the EXACT ALFEAN ENTERPRISES menu names (mfano: "Nenda Dashboard → Madeni → Bonyeza 'Ongeza Deni'") → mifano halisi ya Tanzania (hardware store, TZS, mita/kg/pcs) → makosa ya kawaida ya kuepuka → tips za kitaalamu.
- The reader is already an ALFEAN ENTERPRISES user: teach THE SYSTEM, not business theory.
- Use "wewe"/"wako" tone (direct, friendly, professional).
- End with a CTA: "Ingia 127.0.0.1:47831/login kuendelea" na kwa wasio na akaunti "Jiunge bure 127.0.0.1:47831/register".
- Meta description: 150–160 chars (SEO, include ALFEAN ENTERPRISES POS + feature). Excerpt: 2 sentences. Tags: 3–5 comma-separated lowercase (e.g. hss pos, madeni, pos).
Return ONLY valid JSON: {"title": "...", "excerpt": "...", "meta_description": "...", "tags": "a, b, c", "content_html": "..."}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-flash',
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Andika makala ya kufundisha jinsi ya KUTUMIA kipengele hiki cha ALFEAN ENTERPRISES POS hatua kwa hatua: ${topic}. Eleza menyu halisi za ALFEAN ENTERPRISES na hatua kamili za kufuata.` },
        ],
        max_tokens: 8000,
        temperature: 0.7,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      console.warn('[Blog] AI error:', response.status, (await response.text()).slice(0, 200));
      return null;
    }
    const data: any = await response.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = safeParseJson(content);
    if (!parsed?.title || !parsed?.content_html) {
      console.warn('[Blog] AI returned unusable JSON (length', String(content).length + ')');
      return null;
    }
    return {
      title: String(parsed.title).slice(0, 300),
      excerpt: String(parsed.excerpt || stripTags(parsed.content_html).slice(0, 300)).slice(0, 400),
      meta_description: String(parsed.meta_description || '').slice(0, 200),
      tags: String(parsed.tags || '').slice(0, 200),
      content_html: sanitizeHtml(parsed.content_html),
    };
  } catch (e: any) {
    console.warn('[Blog] AI generation failed:', e.message);
    return null;
  }
}

async function uniqueSlug(base: string): Promise<string> {
  let slug = slugify(base) || `makala-${Date.now()}`;
  for (let i = 0; i < 20; i++) {
    const exists = await pool.query(`SELECT 1 FROM blog_posts WHERE slug = $1`, [slug]);
    if (exists.rows.length === 0) return slug;
    slug = `${slugify(base)}-${i + 2}`;
  }
  return `${slugify(base)}-${Date.now().toString(36)}`;
}

async function blogNotifyEmail(): Promise<string | null> {
  try {
    const r = await pool.query(`SELECT value FROM system_settings WHERE key = 'blog_notify_email' LIMIT 1`);
    const v = r.rows[0]?.value;
    const email = typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v;
    if (email && String(email).includes('@')) return String(email);
  } catch { /* fall through */ }
  try {
    const dev = await pool.query(`SELECT email FROM "user" WHERE role = 'developer' AND email IS NOT NULL ORDER BY created_at ASC LIMIT 1`);
    return dev.rows[0]?.email || null;
  } catch {
    return null;
  }
}

function blogEmailHtml(post: any): string {
  // One professional, fully-inlined design shared with the tenant marketing
  // email — the developer version adds the "Badilisha / Hariri" button.
  return buildBlogEmailHtml(
    {
      slug: post.slug,
      title: post.title,
      excerpt: post.excerpt,
      content_html: post.content_html,
      published_at: post.published_at,
      tags: post.tags,
      cover_image: post.cover_image,
    },
    { personalized: false, forDeveloper: true }
  );
}

/** Generates today's article, publishes it, and emails the developer. */
export async function generateDailyBlogPost(opts?: { publish?: boolean }): Promise<any> {
  const publish = opts?.publish !== false;
  const topic = await nextTopic();
  const article = await generateArticle(topic);
  if (!article) return { success: false, error: 'AI generation failed (check DEEPSEEK_API_KEY)' };

  const slug = await uniqueSlug(article.title);
  const ins = await pool.query(
    `INSERT INTO blog_posts (slug, title, excerpt, content_html, tags, meta_description, status, source, ai_topic, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'ai', $8, CASE WHEN $7::varchar = 'published' THEN NOW() ELSE NULL END)
     RETURNING *`,
    [slug, article.title, article.excerpt, article.content_html, article.tags, article.meta_description, publish ? 'published' : 'draft', topic]
  );
  const post = ins.rows[0];

  const to = await blogNotifyEmail();
  if (to) {
    try {
      await sendEmail({
        to,
        subject: `📝 Makala Mpya: ${post.title}`,
        html: blogEmailHtml(post),
        templateKey: 'blog_daily',
      });
      console.log(`[Blog] Daily article published: ${post.slug} (email → ${to})`);
    } catch (e: any) {
      console.warn('[Blog] Notify email failed:', e.message);
    }
  }
  return { success: true, post };
}

export function startBlogDailyCron(): void {
  // 07:00 Tanzania time — fresh article every morning before business hours.
  cron.schedule('0 7 * * *', async () => {
    console.log('[cron] Writing daily blog article...');
    try {
      const r = await generateDailyBlogPost();
      console.log(`[cron] Blog: ${r.success ? r.post.slug : 'FAILED — ' + r.error}`);
    } catch (e: any) {
      console.error('[cron] Blog writer error:', e.message);
    }
  }, { timezone: 'Africa/Dar_es_Salaam' });
  console.log('[cron] Blog writer registered (daily 07:00 EAT, AI-generated, auto-published)');
}

// ─── Public routes ───────────────────────────────────────────────────────────

export const blogPublicRoutes = new Hono();

blogPublicRoutes.get('/', async (c) => {
  try {
    const page = Math.max(1, parseInt(c.req.query('page') || '1'));
    const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '12')));
    const offset = (page - 1) * limit;
    const count = await pool.query(`SELECT COUNT(*)::int AS n FROM blog_posts WHERE status = 'published'`);
    const rows = await pool.query(
      `SELECT id, slug, title, excerpt, cover_image, tags, views, published_at
       FROM blog_posts WHERE status = 'published'
       ORDER BY published_at DESC NULLS LAST, created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const total = Number(count.rows[0]?.n) || 0;
    return c.json({ success: true, data: rows.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 } });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

blogPublicRoutes.get('/sitemap.xml', async (c) => {
  try {
    const rows = await pool.query(`SELECT slug, updated_at FROM blog_posts WHERE status = 'published' ORDER BY published_at DESC LIMIT 1000`);
    const urls = rows.rows.map((r: any) => `  <url><loc>${APP_URL}/blog/${r.slug}</loc><lastmod>${new Date(r.updated_at).toISOString().slice(0, 10)}</lastmod><changefreq>weekly</changefreq></url>`).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${APP_URL}/</loc><changefreq>daily</changefreq></url>\n  <url><loc>${APP_URL}/blog</loc><changefreq>daily</changefreq></url>\n${urls}\n</urlset>`;
    return c.body(xml, 200, { 'Content-Type': 'application/xml; charset=utf-8' });
  } catch {
    return c.body('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>', 200, { 'Content-Type': 'application/xml' });
  }
});

blogPublicRoutes.get('/:slug', async (c) => {
  try {
    const slug = c.req.param('slug');
    const r = await pool.query(
      `SELECT id, slug, title, excerpt, content_html, cover_image, tags, meta_description, views, published_at, updated_at
       FROM blog_posts WHERE slug = $1 AND status = 'published' LIMIT 1`,
      [slug]
    );
    if (r.rows.length === 0) return c.json({ success: false, error: 'Not found' }, 404);
    pool.query(`UPDATE blog_posts SET views = views + 1 WHERE id = $1`, [r.rows[0].id]).catch(() => {});
    return c.json({ success: true, data: r.rows[0] });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// ─── Developer routes ────────────────────────────────────────────────────────

export const blogDevRoutes = new Hono();

const requireDeveloper = async (c: any, next: any) => {
  if (c.get('userRole') !== 'developer') return c.json({ success: false, error: 'Developer only' }, 403);
  await next();
};

blogDevRoutes.get('/', authMiddleware, requireDeveloper, async (c) => {
  try {
    const page = Math.max(1, parseInt(c.req.query('page') || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50')));
    const offset = (page - 1) * limit;
    const count = await pool.query(`SELECT COUNT(*)::int AS n FROM blog_posts`);
    const rows = await pool.query(
      `SELECT id, slug, title, excerpt, tags, status, source, ai_topic, views, published_at, created_at, updated_at,
              LEFT(content_html, 200) AS content_preview
       FROM blog_posts ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const total = Number(count.rows[0]?.n) || 0;
    return c.json({ success: true, data: rows.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 } });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

blogDevRoutes.get('/:id', authMiddleware, requireDeveloper, async (c) => {
  try {
    const r = await pool.query(`SELECT * FROM blog_posts WHERE id = $1 LIMIT 1`, [c.req.param('id')]);
    if (r.rows.length === 0) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: r.rows[0] });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

blogDevRoutes.post('/generate', authMiddleware, requireDeveloper, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const result = await generateDailyBlogPost({ publish: body?.publish !== false });
    if (!result.success) return c.json({ success: false, error: result.error }, 500);
    return c.json({ success: true, data: result.post, message: `Makala imeandikwa: ${result.post.title}` });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

blogDevRoutes.post('/', authMiddleware, requireDeveloper, async (c) => {
  try {
    const b = await c.req.json();
    if (!b?.title || !b?.content_html) return c.json({ success: false, error: 'title na content_html vinahitajika' }, 400);
    const slug = await uniqueSlug(b.slug || b.title);
    const r = await pool.query(
      `INSERT INTO blog_posts (slug, title, excerpt, content_html, cover_image, tags, meta_description, status, source, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', CASE WHEN $8::varchar = 'published' THEN NOW() ELSE NULL END)
       RETURNING *`,
      [slug, b.title, b.excerpt || '', sanitizeHtml(b.content_html), b.cover_image || null, b.tags || '', b.meta_description || '', b.status === 'published' ? 'published' : 'draft']
    );
    return c.json({ success: true, data: r.rows[0] }, 201);
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

blogDevRoutes.put('/:id', authMiddleware, requireDeveloper, async (c) => {
  try {
    const id = c.req.param('id');
    const b = await c.req.json();
    const cur = await pool.query(`SELECT * FROM blog_posts WHERE id = $1`, [id]);
    if (cur.rows.length === 0) return c.json({ success: false, error: 'Not found' }, 404);
    const prev = cur.rows[0];
    const status = b.status || prev.status;
    let slug = prev.slug;
    if (b.slug && slugify(b.slug) !== prev.slug) slug = await uniqueSlug(b.slug);
    const r = await pool.query(
      `UPDATE blog_posts SET
         slug = $2, title = $3, excerpt = $4, content_html = $5, cover_image = $6,
         tags = $7, meta_description = $8, status = $9::varchar,
         published_at = CASE WHEN $9::varchar = 'published' AND published_at IS NULL THEN NOW() ELSE published_at END,
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, slug, b.title ?? prev.title, b.excerpt ?? prev.excerpt, b.content_html ? sanitizeHtml(b.content_html) : prev.content_html,
       b.cover_image !== undefined ? b.cover_image : prev.cover_image, b.tags ?? prev.tags, b.meta_description ?? prev.meta_description, status]
    );
    return c.json({ success: true, data: r.rows[0] });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

blogDevRoutes.delete('/:id', authMiddleware, requireDeveloper, async (c) => {
  try {
    await pool.query(`DELETE FROM blog_posts WHERE id = $1`, [c.req.param('id')]);
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});
