// =====================================================
// NOTEBOOK (DAFTARI) MODULE
// =====================================================
// Personal notes for each user: a header ("Kichwa cha taarifa") plus one or
// more formatted description sections ("Maelezo"). The content is stored as
// Markdown so the client can render it professionally (headings, bullets,
// bold, checklists, quotes...) and copy/share it with formatting intact.
//
// Notes are private: every query is scoped to the signed-in user's id, so no
// other shop, tenant or staff member can read or modify someone's notebook.
// =====================================================

import { Hono } from 'hono';
import { pool } from '../../config/drizzle.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { requirePermission } from '../../middleware/rbac.middleware.js';

const router = new Hono();

// Notebook access is a per-member toggle (notebook:read). Members get it by
// default; the owner can hide the module entirely for a member.
router.use('*', authMiddleware, requirePermission('notebook:read'));

// Self-healing schema. Called at boot (index.ts) and lazily on first use so a
// server that was already running when the feature was deployed still works.
let notesSchemaReady = false;
export async function ensureNotesSchema(): Promise<void> {
  if (notesSchemaReady) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notebook_notes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id VARCHAR(255) NOT NULL,
        tenant_id VARCHAR(255),
        title VARCHAR(255) NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS notebook_notes_user_idx ON notebook_notes(user_id, updated_at DESC);
    `);
    notesSchemaReady = true;
  } catch (e: any) {
    console.warn('[Notebook] schema ensure failed:', e.message);
  }
}

const MAX_CONTENT = 200000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cleanString = (value: any, max: number) => String(value ?? '').slice(0, max);

// GET /api/notes?search= -> the caller's notes, newest first.
router.get('/', authMiddleware, async (c: any) => {
  await ensureNotesSchema();
  try {
    const userId = c.get('userId') as string;
    const search = (c.req.query('search') || '').trim();
    const params: any[] = [userId];
    let where = 'user_id = $1';
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (title ILIKE $2 OR content ILIKE $2)`;
    }
    const result = await pool.query(
      `SELECT id, title, LEFT(content, 400) AS snippet, created_at, updated_at
         FROM notebook_notes
        WHERE ${where}
        ORDER BY updated_at DESC
        LIMIT 300`,
      params
    );
    return c.json({ success: true, data: { notes: result.rows } });
  } catch (error: any) {
    console.error('[Notebook] list error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// GET /api/notes/:id -> one note (owner only).
router.get('/:id', authMiddleware, async (c: any) => {
  await ensureNotesSchema();
  try {
    const userId = c.get('userId') as string;
    const result = await pool.query(
      `SELECT id, title, content, created_at, updated_at
         FROM notebook_notes WHERE id = $1 AND user_id = $2`,
      [c.req.param('id'), userId]
    );
    if (result.rows.length === 0) return c.json({ success: false, error: 'Note not found' }, 404);
    return c.json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// POST /api/notes { id?, title, content } -> create.
// The client may send its own UUID so an offline-queued save can be replayed
// without ever creating a duplicate note (upsert on conflict).
router.post('/', authMiddleware, async (c: any) => {
  await ensureNotesSchema();
  try {
    const userId = c.get('userId') as string;
    const tenantId = (c.get('tenantId') as string) || null;
    const body = await c.req.json();
    const title = cleanString(body.title, 255).trim();
    const content = cleanString(body.content, MAX_CONTENT);
    if (!title && !content.trim()) {
      return c.json({ success: false, error: 'Write something before saving' }, 400);
    }

    const clientId = typeof body.id === 'string' && UUID_RE.test(body.id) ? body.id : null;

    if (clientId) {
      const upsert = await pool.query(
        `INSERT INTO notebook_notes (id, user_id, tenant_id, title, content)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE
           SET title = EXCLUDED.title, content = EXCLUDED.content, updated_at = NOW()
           WHERE notebook_notes.user_id = EXCLUDED.user_id
         RETURNING id, title, content, created_at, updated_at`,
        [clientId, userId, tenantId, title, content]
      );
      if (upsert.rows.length > 0) {
        return c.json({ success: true, data: upsert.rows[0] }, 201);
      }
      // The id exists but belongs to someone else — fall through to a normal insert.
    }

    const result = await pool.query(
      `INSERT INTO notebook_notes (user_id, tenant_id, title, content)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, content, created_at, updated_at`,
      [userId, tenantId, title, content]
    );
    return c.json({ success: true, data: result.rows[0] }, 201);
  } catch (error: any) {
    console.error('[Notebook] create error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// PUT /api/notes/:id { title, content } -> update.
router.put('/:id', authMiddleware, async (c: any) => {
  await ensureNotesSchema();
  try {
    const userId = c.get('userId') as string;
    const body = await c.req.json();
    const title = cleanString(body.title, 255).trim();
    const content = cleanString(body.content, MAX_CONTENT);
    if (!title && !content.trim()) {
      return c.json({ success: false, error: 'Write something before saving' }, 400);
    }
    const result = await pool.query(
      `UPDATE notebook_notes
          SET title = $1, content = $2, updated_at = NOW()
        WHERE id = $3 AND user_id = $4
        RETURNING id, title, content, created_at, updated_at`,
      [title, content, c.req.param('id'), userId]
    );
    if (result.rows.length === 0) return c.json({ success: false, error: 'Note not found' }, 404);
    return c.json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    console.error('[Notebook] update error:', error.message);
    return c.json({ success: false, error: error.message }, 400);
  }
});

// DELETE /api/notes/:id
router.delete('/:id', authMiddleware, async (c: any) => {
  await ensureNotesSchema();
  try {
    const userId = c.get('userId') as string;
    const result = await pool.query(
      `DELETE FROM notebook_notes WHERE id = $1 AND user_id = $2 RETURNING id`,
      [c.req.param('id'), userId]
    );
    if (result.rows.length === 0) return c.json({ success: false, error: 'Note not found' }, 404);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

export default router;
