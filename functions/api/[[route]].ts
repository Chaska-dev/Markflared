import { Hono } from 'hono';
import { handle } from 'hono/cloudflare-pages';
import type { Context } from 'hono';
import { parseMarkdownToBlocks } from '../../server/shared/markdown';

type Bindings = {
  DB: D1Database;
  BUCKET?: R2Bucket;
  AUTH_USERNAME: string;
  AUTH_PASSWORD: string;
  AUTH_SECRET: string;
};

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const LOGIN_RATE_WINDOW_MS = 60 * 1000; // 1-minute window
const LOGIN_RATE_MAX = 5; // max 5 attempts / min / IP

// In-memory per-instance rate limit. Not perfect at global scale (Workers
// don't share state across isolates) but serves as base defense against
// casual brute force for a personal app. Production multi-tenant should
// move this to Durable Storage or KV.
const loginAttempts = new Map<string, number[]>();

function clientIp(c: Context): string {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

function checkRate(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - LOGIN_RATE_WINDOW_MS;
  const arr = (loginAttempts.get(ip) || []).filter(t => t > windowStart);
  if (arr.length >= LOGIN_RATE_MAX) {
    loginAttempts.set(ip, arr);
    return false;
  }
  arr.push(now);
  loginAttempts.set(ip, arr);
  return true;
}

// Is `candidate` a descendant of `ancestor` in the same page's block tree?
// Used to reject reparentings that would create cycles (moving a block
// inside one of its own children). Capped at 64 hops for safety.
async function isDescendantBlock(db: D1Database, candidate: string, ancestor: string): Promise<boolean> {
  let current: string | null = candidate;
  for (let i = 0; i < 64; i++) {
    if (!current) return false;
    if (current === ancestor) return true;
    const row: any = await db.prepare('SELECT parent_id FROM blocks WHERE id = ?').bind(current).first();
    if (!row) return false;
    current = row.parent_id || null;
  }
  return false;
}

// Normalize a block read from D1: convert `collapsed` to boolean, leave
// `parent_id` as-is (string or null). Used in every route that returns a
// block to the frontend.
function normalizeBlock(b: any): any {
  if (!b) return b;
  return { ...b, collapsed: Boolean(b.collapsed) };
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Constant-time comparison: prevents timing attacks on the bearer token.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function issueToken(username: string, secret: string): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = `${username}:${expiresAt}`;
  const sig = await sha256Hex(`${payload}:${secret}`);
  // token = base64(payload).sig — payload encodes the expiry inside the token itself.
  const b64 = btoa(payload);
  return { token: `${b64}.${sig}`, expiresAt };
}

// Markdown → blocks parser. Imported from server/shared/markdown so the
// Cloudflare Pages backend and the local Express backend share the same
// implementation.

async function verifyToken(token: string, username: string, secret: string): Promise<{ ok: boolean; expired?: boolean }> {
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return { ok: false };
  const b64 = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  let payload: string;
  try {
    payload = atob(b64);
  } catch {
    return { ok: false };
  }
  // Recompute the expected sig and compare in constant time.
  const expectedSig = await sha256Hex(`${payload}:${secret}`);
  if (!timingSafeEqual(sig, expectedSig)) return { ok: false };
  // Validate that the payload belongs to this username (prevents token
  // reuse across users).
  const sep = payload.lastIndexOf(':');
  if (sep <= 0) return { ok: false };
  const userPart = payload.slice(0, sep);
  if (!timingSafeEqual(userPart, username)) return { ok: false };
  const expStr = payload.slice(sep + 1);
  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return { ok: false };
  if (Date.now() >= exp) return { ok: false, expired: true };
  return { ok: true };
}

function requireEnv(c: Context<{ Bindings: Bindings }>): { username: string; password: string; secret: string } | null {
  const { AUTH_USERNAME, AUTH_PASSWORD, AUTH_SECRET } = c.env;
  if (!AUTH_USERNAME || !AUTH_PASSWORD || !AUTH_SECRET) {
    console.error('Auth env vars missing: AUTH_USERNAME/AUTH_PASSWORD/AUTH_SECRET must be set');
    return null;
  }
  return { username: AUTH_USERNAME, password: AUTH_PASSWORD, secret: AUTH_SECRET };
}

const app = new Hono<{ Bindings: Bindings }>().basePath('/api');

let schemaInitialized = false;

// Ensure the necessary tables exist in Cloudflare D1 (files, workspace,
// page_shares) even if the remote migrations weren't run manually with
// wrangler.
async function ensureSchema(db: D1Database) {
  if (schemaInitialized) return;
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL,
        page_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_files_page ON files(page_id);

      CREATE TABLE IF NOT EXISTS workspace (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT NOT NULL DEFAULT 'My Workspace',
        icon TEXT NOT NULL DEFAULT '📋',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO workspace (id, name, icon) VALUES (1, 'My Workspace', '📋');

      CREATE TABLE IF NOT EXISTS page_shares (
        page_id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_page_shares_token ON page_shares(token);
    `);
    schemaInitialized = true;
  } catch (err) {
    console.error('[db] ensureSchema error:', err);
  }
}

// Foreign keys ON per request. D1 (Cloudflare), like SQLite, has
// foreign_keys = OFF by default on every new connection.
app.use('*', async (c, next) => {
  if (c.env?.DB) {
    await c.env.DB.exec('PRAGMA foreign_keys = ON');
    await ensureSchema(c.env.DB);
  }
  await next();
});

// CORS: same-origin by default. In Pages the frontend and /api live on the
// same host, so cross-origin isn't needed. If you ever open a separate
// frontend, set ALLOWED_ORIGIN in env vars and add it to the allow-list.
app.use('*', async (c, next) => {
  const origin = c.req.header('Origin');
  if (origin) {
    // Only allow same-origin (same host) or none.
    try {
      const reqUrl = new URL(c.req.url);
      const originUrl = new URL(origin);
      if (originUrl.host === reqUrl.host) {
        c.res.headers.set('Access-Control-Allow-Origin', origin);
        c.res.headers.set('Vary', 'Origin');
      }
    } catch {
      // invalid origin, ignore
    }
  }
  await next();
});

app.post('/auth/login', async (c) => {
  const env = requireEnv(c);
  if (!env) return c.json({ error: 'Service unavailable' }, 503);

  const ip = clientIp(c);
  if (!checkRate(ip)) {
    return c.json({ error: 'Too many attempts. Try again later.' }, 429);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid body' }, 400);
  }
  if (!body || typeof body !== 'object') return c.json({ error: 'Invalid body' }, 400);

  const { username, password } = body as Record<string, unknown>;
  if (typeof username !== 'string' || typeof password !== 'string') {
    return c.json({ error: 'Invalid credentials' }, 400);
  }
  if (username.length > 128 || password.length > 1024) {
    return c.json({ error: 'Invalid credentials' }, 400);
  }

  // Constant-time comparison for user/pass too.
  const uOk = timingSafeEqual(username, env.username);
  const pOk = timingSafeEqual(password, env.password);
  if (!uOk || !pOk) {
    console.warn(`auth.login failed ip=${ip}`);
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const { token, expiresAt } = await issueToken(env.username, env.secret);
  return c.json({ token, username: env.username, expiresAt });
});

// Public share endpoints (NO auth required).
// Anyone with the link can view the shared page and all its descendants.
// The client decides what to render (split layout in our case). Since
// these routes don't match /pages, /blocks, etc., the auth middleware
// below doesn't intercept them — they're public by design.

// Generate a URL-safe 128-bit token (16 bytes base64url = 22 chars).
// Enough entropy to be unguessable; URL-safe so no escaping needed in the bar.
function generateShareToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // base64url encoding (no '+', '/', '=').
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Look up the share root by token. Returns null if the token doesn't exist
// or the share was revoked.
async function findShareRoot(c: Context<{ Bindings: Bindings }>, token: string): Promise<any | null> {
  const row: any = await c.env.DB
    .prepare('SELECT page_id FROM page_shares WHERE token = ? AND revoked = 0')
    .bind(token)
    .first();
  if (!row) return null;
  return await c.env.DB.prepare('SELECT * FROM pages WHERE id = ?').bind(row.page_id).first();
}

// GET /api/share/:token — public tree of the shared page.
// Returns the root + flat list of descendants; the frontend builds the tree
// with the same logic as `buildPageTree` (consistency between authed and
// public views).
app.get('/share/:token', async (c) => {
  try {
    const token = c.req.param('token');
    const root = await findShareRoot(c, token);
    if (!root) return c.json({ error: 'Link not found or disabled' }, 404);

    const ids = await collectDescendantPageIds(c, root.id);
    const placeholders = ids.map(() => '?').join(',');
    const { results: pages } = await c.env.DB
      .prepare(`SELECT * FROM pages WHERE id IN (${placeholders}) ORDER BY position ASC, created_at ASC`)
      .bind(...ids)
      .all();
    return c.json({ root, pages });
  } catch (err: any) {
    console.error('Error in GET /share/:token:', err);
    return c.json({ error: err?.message || 'Error fetching shared page' }, 500);
  }
});

// GET /api/share/:token/page/:pageId — content (page + blocks) of a page
// inside the share. We validate that pageId is a descendant of root so a
// visitor can't request any workspace page with a valid token (defense
// against enumeration).
app.get('/share/:token/page/:pageId', async (c) => {
  try {
    const token = c.req.param('token');
    const pageId = c.req.param('pageId');
    const root = await findShareRoot(c, token);
    if (!root) return c.json({ error: 'Link not found or disabled' }, 404);

    const allowedIds = await collectDescendantPageIds(c, root.id);
    if (!allowedIds.includes(pageId)) {
      return c.json({ error: 'Page outside the shared link' }, 403);
    }

    const page: any = await c.env.DB.prepare('SELECT * FROM pages WHERE id = ?').bind(pageId).first();
    if (!page) return c.json({ error: 'Page not found' }, 404);
    const { results: blocks } = await c.env.DB
      .prepare('SELECT * FROM blocks WHERE page_id = ? ORDER BY position ASC')
      .bind(pageId)
      .all();
    return c.json({ page, blocks: blocks.map(normalizeBlock) });
  } catch (err: any) {
    console.error('Error in GET /share/:token/page/:pageId:', err);
    return c.json({ error: err?.message || 'Error fetching content' }, 500);
  }
});

const authMiddleware = async (c: Context<{ Bindings: Bindings }>, next: () => Promise<void>) => {
  const env = requireEnv(c);
  if (!env) return c.json({ error: 'Service unavailable' }, 503);

  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return c.json({ error: 'Unauthorized' }, 401);

  const v = await verifyToken(token, env.username, env.secret);
  if (!v.ok) {
    return c.json({ error: v.expired ? 'Session expired' : 'Unauthorized' }, 401);
  }
  await next();
};

app.use('/pages/*', authMiddleware);
app.use('/blocks/*', authMiddleware);
app.use('/files/upload', authMiddleware);
app.use('/workspace/*', authMiddleware);
app.use('/search', authMiddleware);

// Share management (auth-gated) — endpoints for the page owner to create,
// query, and deactivate the page's public link. Each page has at most ONE
// active share at a time (page_id is the PK).

// POST /api/pages/:id/share — activates the share. If a revoked one already
// existed, reuse the slot (same PK) and generate a new token.
app.post('/pages/:id/share', async (c) => {
  try {
    const pageId = c.req.param('id');
    const page: any = await c.env.DB.prepare('SELECT id FROM pages WHERE id = ?').bind(pageId).first();
    if (!page) return c.json({ error: 'Page not found' }, 404);

    const existing: any = await c.env.DB
      .prepare('SELECT token, revoked FROM page_shares WHERE page_id = ?')
      .bind(pageId)
      .first();

    const token = generateShareToken();
    if (existing) {
      await c.env.DB.prepare(
        "UPDATE page_shares SET token = ?, revoked = 0, created_at = datetime('now') WHERE page_id = ?"
      ).bind(token, pageId).run();
    } else {
      await c.env.DB.prepare(
        'INSERT INTO page_shares (page_id, token, revoked) VALUES (?, ?, 0)'
      ).bind(pageId, token).run();
    }
    return c.json({ token, revoked: false, created_at: new Date().toISOString() });
  } catch (err: any) {
    console.error('Error in POST /pages/:id/share:', err);
    return c.json({ error: err?.message || 'Error activating link' }, 500);
  }
});

// GET /api/pages/:id/share — returns share info if active, or 404.
app.get('/pages/:id/share', async (c) => {
  try {
    const pageId = c.req.param('id');
    const row: any = await c.env.DB
      .prepare('SELECT token, revoked, created_at FROM page_shares WHERE page_id = ? AND revoked = 0')
      .bind(pageId)
      .first();
    if (!row) return c.json({ error: 'Sin share activo' }, 404);
    return c.json({ ...row, revoked: Boolean(row.revoked) });
  } catch (err: any) {
    console.error('Error in GET /pages/:id/share:', err);
    return c.json({ error: err?.message || 'Error querying share' }, 500);
  }
});

// DELETE /api/pages/:id/share — revokes the share. Keeps the row (we
// don't delete it) so a future POST reuses the slot instead of creating another.
app.delete('/pages/:id/share', async (c) => {
  try {
    const pageId = c.req.param('id');
    const result = await c.env.DB.prepare('UPDATE page_shares SET revoked = 1 WHERE page_id = ?').bind(pageId).run();
    return c.json({ success: true, changed: (result as any).meta?.changes ?? 0 });
  } catch (err: any) {
    console.error('Error in DELETE /pages/:id/share:', err);
    return c.json({ error: err?.message || 'Error revoking share' }, 500);
  }
});

// 1. GET /api/pages
app.get('/pages', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM pages ORDER BY position ASC, created_at DESC'
  ).all();
  return c.json({ pages: results });
});

// 2. POST /api/pages
app.post('/pages', async (c) => {
  const body = await c.req.json();
  const id = crypto.randomUUID();
  const title = typeof body.title === 'string' ? body.title.slice(0, 500) : 'Untitled';
  const icon = typeof body.icon === 'string' ? body.icon.slice(0, 32) : '📄';
  const parent_id = typeof body.parent_id === 'string' ? body.parent_id : null;
  const position = Number.isFinite(body.position) ? Number(body.position) : 0;

  await c.env.DB.prepare(
    'INSERT INTO pages (id, title, icon, parent_id, position) VALUES (?1, ?2, ?3, ?4, ?5)'
  ).bind(id, title, icon, parent_id, position).run();

  const blockId = crypto.randomUUID();
  await c.env.DB.prepare(
    'INSERT INTO blocks (id, page_id, type, content, position) VALUES (?1, ?2, ?3, ?4, ?5)'
  ).bind(blockId, id, 'paragraph', '', 0).run();

  const page = await c.env.DB.prepare('SELECT * FROM pages WHERE id = ?').bind(id).first();
  return c.json({ page });
});

// 2.5 POST /api/pages/import
app.post('/pages/import', async (c) => {
  const body = await c.req.json();
  const { markdown, title, parent_id } = body as { markdown?: unknown; title?: unknown; parent_id?: unknown };
  const id = crypto.randomUUID();
  const icon = '📄';

  const safeTitle = typeof title === 'string' ? title.slice(0, 500) : 'Imported';
  const safeParent = typeof parent_id === 'string' ? parent_id : null;

  const { blocks, detectedTitle } = parseMarkdownToBlocks(
    typeof markdown === 'string' ? markdown : '',
    safeTitle
  );

  const pageTitle = detectedTitle || safeTitle || 'Imported';

  await c.env.DB.prepare(
    'INSERT INTO pages (id, title, icon, parent_id, position) VALUES (?1, ?2, ?3, ?4, 0)'
  ).bind(id, pageTitle, icon, safeParent).run();

  const statements = blocks.map((block, index) => {
    return c.env.DB.prepare(
      'INSERT INTO blocks (id, page_id, type, content, checked, position, language) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
    ).bind(crypto.randomUUID(), id, block.type, block.content, block.checked ? 1 : 0, index * 1000, block.language || '');
  });
  if (statements.length > 0) {
    // Cloudflare D1 limita las operaciones batch a 100 statements por llamada.
    // Para archivos medianos/grandes (como README o storyboard de >100 bloques),
    // enviamos en lotes de 50 para garantizar que nunca falle la inserción.
    for (let i = 0; i < statements.length; i += 50) {
      await c.env.DB.batch(statements.slice(i, i + 50));
    }
  }

  const page: any = await c.env.DB.prepare('SELECT * FROM pages WHERE id = ?').bind(id).first();
  const insertedBlocks = await c.env.DB.prepare('SELECT * FROM blocks WHERE page_id = ? ORDER BY position ASC').bind(id).all();
  page.blocks = insertedBlocks.results.map(normalizeBlock);
  return c.json({ page });
});

// 3. GET /api/pages/:id
app.get('/pages/:id', async (c) => {
  const id = c.req.param('id');
  const page = await c.env.DB.prepare('SELECT * FROM pages WHERE id = ?').bind(id).first();
  
  if (!page) {
    return c.json({ error: 'Not found' }, 404);
  }

  const { results: blocks } = await c.env.DB.prepare(
    'SELECT * FROM blocks WHERE page_id = ? ORDER BY position ASC'
  ).bind(id).all();

  return c.json({ page: { ...page, blocks: blocks.map(normalizeBlock) } });
});

// 3.5 GET /api/pages/:id/export
app.get('/pages/:id/export', async (c) => {
  const id = c.req.param('id');
  const page: any = await c.env.DB.prepare('SELECT * FROM pages WHERE id = ?').bind(id).first();
  if (!page) return c.json({ error: 'Not found' }, 404);

  const { results: blocks } = await c.env.DB.prepare(
    'SELECT * FROM blocks WHERE page_id = ? ORDER BY position ASC'
  ).bind(id).all();

  let markdown = '';
  let numberedListCount = 1;

  for (const block of blocks as any[]) {
    if (block.type === 'numbered_list') {
      markdown += `${numberedListCount}. ${block.content}\n`;
      numberedListCount++;
      continue;
    } else {
      numberedListCount = 1;
    }

    switch (block.type) {
      case 'heading1': markdown += `# ${block.content}\n`; break;
      case 'heading2': markdown += `## ${block.content}\n`; break;
      case 'heading3': markdown += `### ${block.content}\n`; break;
      case 'bullet_list': markdown += `- ${block.content}\n`; break;
      case 'todo': markdown += `- [${block.checked ? 'x' : ' '}] ${block.content}\n`; break;
      case 'code': markdown += `\`\`\`${block.language || ''}\n${block.content}\n\`\`\`\n`; break;
      case 'math': markdown += `$$\n${block.content}\n$$\n`; break;
      case 'quote': markdown += `> ${block.content}\n`; break;
      case 'divider': markdown += `---\n`; break;
      case 'callout': markdown += `> 💡 ${block.content}\n`; break;
      case 'image': markdown += `![image](/api/files/${block.content})\n`; break;
      case 'file': markdown += `[filename](/api/files/${block.content})\n`; break;
      case 'paragraph': 
      default:
        markdown += `${block.content}\n`; break;
    }
  }

  return c.json({ markdown: markdown.trim(), title: page.title });
});

// 4. PUT /api/pages/:id
app.put('/pages/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  
  const updates: string[] = [];
  const params: any[] = [];
  let index = 1;

  if (typeof body.title === 'string') { updates.push(`title = ?${index++}`); params.push(body.title.slice(0, 500)); }
  if (typeof body.icon === 'string') { updates.push(`icon = ?${index++}`); params.push(body.icon.slice(0, 32)); }
  if (body.parent_id === null || typeof body.parent_id === 'string') { updates.push(`parent_id = ?${index++}`); params.push(body.parent_id); }
  if (Number.isFinite(body.position)) { updates.push(`position = ?${index++}`); params.push(Number(body.position)); }
  
  updates.push(`updated_at = datetime('now')`);
  params.push(id);

  if (updates.length > 1) {
    const query = `UPDATE pages SET ${updates.join(', ')} WHERE id = ?${index}`;
    await c.env.DB.prepare(query).bind(...params).run();
  }

  const page = await c.env.DB.prepare('SELECT * FROM pages WHERE id = ?').bind(id).first();
  return c.json({ page });
});

// 5. DELETE /api/pages/:id (cascade: delete subpages + blocks in a tx)
app.delete('/pages/:id', async (c) => {
  const id = c.req.param('id');
  const pageIds = await collectDescendantPageIds(c, id);
  // D1 doesn't support multi-statement transactions outside of batch, so we
  // use batch: delete blocks per page, then the pages.
  const stmts: D1PreparedStatement[] = [];
  for (const pid of pageIds) {
    stmts.push(c.env.DB.prepare('DELETE FROM blocks WHERE page_id = ?').bind(pid));
  }
  for (const pid of pageIds) {
    stmts.push(c.env.DB.prepare('DELETE FROM pages WHERE id = ?').bind(pid));
  }
  if (stmts.length > 0) await c.env.DB.batch(stmts);
  return c.json({ success: true, deletedPages: pageIds.length });
});

// 5b. GET /api/pages/:id/cascade-count
app.get('/pages/:id/cascade-count', async (c) => {
  const id = c.req.param('id');
  const pageIds = await collectDescendantPageIds(c, id);
  if (pageIds.length === 0) return c.json({ pages: 0, blocks: 0 });
  const placeholders = pageIds.map(() => '?').join(',');
  const row = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n FROM blocks WHERE page_id IN (${placeholders})`)
    .bind(...pageIds)
    .first<{ n: number }>();
  return c.json({ pages: pageIds.length, blocks: row?.n ?? 0 });
});

// BFS over parent_id to collect all descendants (including the root).
async function collectDescendantPageIds(c: Context<{ Bindings: Bindings }>, rootId: string): Promise<string[]> {
  const result: string[] = [];
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);
    const { results } = await c.env.DB
      .prepare('SELECT id FROM pages WHERE parent_id = ?')
      .bind(current)
      .all<{ id: string }>();
    for (const r of results) queue.push(r.id);
  }
  return result;
}

// 6. POST /api/pages/:pageId/blocks
app.post('/pages/:pageId/blocks', async (c) => {
  const pageId = c.req.param('pageId');
  const body = await c.req.json();
  const id = crypto.randomUUID();

  const type = typeof body.type === 'string' ? body.type.slice(0, 32) : 'paragraph';
  const content = typeof body.content === 'string' ? body.content : '';
  const position = Number.isFinite(body.position) ? Number(body.position) : 0;
  const language = typeof body.language === 'string' ? body.language.slice(0, 100) : '';
  // Optional parent_id: if a non-empty string is sent we accept it; anything
  // else (including explicit null) means "no parent". We validate that it
  // belongs to the same page so we don't create cross-page references.
  let parent_id: string | null = null;
  if (typeof body.parent_id === 'string' && body.parent_id.length > 0) {
    const parentCheck: any = await c.env.DB.prepare(
      'SELECT id, page_id FROM blocks WHERE id = ?'
    ).bind(body.parent_id).first();
    if (parentCheck && parentCheck.page_id === pageId) {
      parent_id = parentCheck.id;
    }
  }

  await c.env.DB.prepare(
    'INSERT INTO blocks (id, page_id, type, content, position, parent_id, language) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
  ).bind(id, pageId, type, content, position, parent_id, language).run();

  const block: any = await c.env.DB.prepare('SELECT * FROM blocks WHERE id = ?').bind(id).first();
  return c.json({ block: normalizeBlock(block) });
});

// 7. PUT /api/blocks/:id
app.put('/blocks/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  
  const updates: string[] = [];
  const params: any[] = [];
  let index = 1;

  if (typeof body.content === 'string') { updates.push(`content = ?${index++}`); params.push(body.content); }
  if (typeof body.type === 'string') { updates.push(`type = ?${index++}`); params.push(body.type.slice(0, 32)); }
  if (typeof body.checked === 'boolean') { updates.push(`checked = ?${index++}`); params.push(body.checked ? 1 : 0); }
  if (typeof body.language === 'string') { updates.push(`language = ?${index++}`); params.push(body.language.slice(0, 32)); }
  if (Number.isFinite(body.position)) { updates.push(`position = ?${index++}`); params.push(Number(body.position)); }
  // parent_id: accept a non-empty string or explicit null. Any other value
  // (undefined, number, object) we ignore to avoid corrupting the tree.
  // If it's a string, validate the parent exists and lives in the same page.
  if (body.parent_id === null) {
    updates.push(`parent_id = ?${index++}`); params.push(null);
  } else if (typeof body.parent_id === 'string' && body.parent_id.length > 0) {
    const parentCheck: any = await c.env.DB.prepare(
      'SELECT id, page_id FROM blocks WHERE id = ?'
    ).bind(body.parent_id).first();
    if (parentCheck) {
      // Also avoid creating cycles: if the destination is a descendant of
      // this block, we silently reject it.
      const isCycle = await isDescendantBlock(c.env.DB, body.parent_id, id);
      if (!isCycle) {
        updates.push(`parent_id = ?${index++}`); params.push(body.parent_id);
      }
    }
  }
  // collapsed: 0/1 boolean
  if (typeof body.collapsed === 'boolean') {
    updates.push(`collapsed = ?${index++}`); params.push(body.collapsed ? 1 : 0);
  }

  updates.push(`updated_at = datetime('now')`);
  params.push(id);

  if (updates.length > 1) {
    const query = `UPDATE blocks SET ${updates.join(', ')} WHERE id = ?${index}`;
    await c.env.DB.prepare(query).bind(...params).run();
  }

  const block: any = await c.env.DB.prepare('SELECT * FROM blocks WHERE id = ?').bind(id).first();
  return c.json({ block: normalizeBlock(block) });
});

// 8. DELETE /api/blocks/:id
app.delete('/blocks/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM blocks WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

// 9. PUT /api/blocks/reorder
app.put('/blocks/reorder', async (c) => {
  const body = await c.req.json();
  const blocks = Array.isArray(body.blocks) ? body.blocks as { id: unknown; position: unknown }[] : [];
  const safe = blocks
    .filter(b => b && typeof b === 'object' && typeof b.id === 'string' && Number.isFinite(b.position))
    .map(b => ({ id: b.id as string, position: Number(b.position) }));
  
  try {
    const statements = safe.map(block => 
      c.env.DB.prepare('UPDATE blocks SET position = ?1, updated_at = datetime(\'now\') WHERE id = ?2')
        .bind(block.position, block.id)
    );
    
    if (statements.length > 0) {
      await c.env.DB.batch(statements);
    }
    return c.json({ success: true });
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

// 9b. GET /api/search — global search by pages and block content
app.get('/search', async (c) => {
  const q = (c.req.query('q') || '').trim();
  if (!q) return c.json({ results: [] });

  const pattern = `%${q}%`;

  const { results: matchedPages } = await c.env.DB.prepare(
    'SELECT id, title, icon, updated_at FROM pages WHERE title LIKE ? ORDER BY updated_at DESC LIMIT 10'
  ).bind(pattern).all();

  const { results: matchedBlocks } = await c.env.DB.prepare(
    `SELECT b.id, b.page_id, b.content, b.type, b.updated_at, p.title as page_title, p.icon as page_icon
     FROM blocks b
     JOIN pages p ON b.page_id = p.id
     WHERE b.content LIKE ? AND b.type NOT IN ('divider', 'subpage')
     ORDER BY b.updated_at DESC LIMIT 25`
  ).bind(pattern).all();

  const results: any[] = [];

  for (const p of (matchedPages as any[])) {
    results.push({
      id: p.id,
      page_id: p.id,
      title: p.title || 'Untitled',
      icon: p.icon || '📄',
      match_type: 'page',
      snippet: p.title,
      updated_at: p.updated_at,
    });
  }

  for (const b of (matchedBlocks as any[])) {
    results.push({
      id: b.id,
      page_id: b.page_id,
      title: b.page_title || 'Untitled',
      icon: b.page_icon || '📄',
      match_type: 'block',
      block_type: b.type,
      snippet: b.content.slice(0, 140),
      updated_at: b.updated_at,
    });
  }

  return c.json({ results });
});

// 10. POST /api/files/upload (with Cloudflare R2 support and D1 fallback)
app.post('/files/upload', async (c) => {
  const formData = await c.req.parseBody();
  const file = formData['file'] as File;
  const pageId = formData['page_id'] as string | undefined;
  
  if (!file) return c.json({ error: 'No file' }, 400);
  if (file.size > 25 * 1024 * 1024) return c.json({ error: 'File too large (max 25MB)' }, 400);
  if (!c.env.BUCKET && file.size > 750 * 1024) {
    return c.json({
      error: 'No Cloudflare R2 configured, the maximum file size supported in D1 is 750KB. Enable [[r2_buckets]] in wrangler.toml to support up to 25MB.'
    }, 400);
  }

  const id = crypto.randomUUID();
  const buffer = await file.arrayBuffer();

  if (c.env.BUCKET) {
    // Store in Cloudflare R2
    await c.env.BUCKET.put(id, buffer, {
      httpMetadata: { contentType: file.type || 'application/octet-stream' },
      customMetadata: { name: file.name },
    });

    await c.env.DB.prepare(
      'INSERT INTO files (id, name, mime_type, size, data, page_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
    ).bind(id, file.name.slice(0, 255), (file.type || 'application/octet-stream').slice(0, 128), file.size, 'r2', pageId || null).run();
  } else {
    // Fallback to D1 (base64)
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    await c.env.DB.prepare(
      'INSERT INTO files (id, name, mime_type, size, data, page_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
    ).bind(id, file.name.slice(0, 255), (file.type || 'application/octet-stream').slice(0, 128), file.size, base64, pageId || null).run();
  }

  const newFile: any = await c.env.DB.prepare('SELECT id, name, mime_type, size, page_id, created_at FROM files WHERE id = ?').bind(id).first();
  newFile.url = `/api/files/${id}`;

  return c.json({ file: newFile });
});

// 11. GET /api/files/:id (supports R2 and D1 with cache)
app.get('/files/:id', async (c) => {
  const id = c.req.param('id');

  if (c.env.BUCKET) {
    const object = await c.env.BUCKET.get(id);
    if (object) {
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('etag', object.httpEtag);
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      if (!headers.has('Content-Type')) {
        const fileRow: any = await c.env.DB.prepare('SELECT mime_type FROM files WHERE id = ?').bind(id).first();
        if (fileRow?.mime_type) headers.set('Content-Type', fileRow.mime_type);
      }
      return new Response(object.body, { headers });
    }
  }

  const file: any = await c.env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(id).first();
  if (!file) return c.json({ error: 'Not found' }, 404);
  if (file.data === 'r2') return c.json({ error: 'File not found in storage' }, 404);

  const binaryString = atob(file.data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return new Response(bytes, {
    headers: {
      'Content-Type': file.mime_type,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
});

// 12. GET /api/workspace — returns the singleton with the current name and icon.
app.get('/workspace', async (c) => {
  let row: any = await c.env.DB.prepare('SELECT name, icon FROM workspace WHERE id = 1').first();
  if (!row) {
    // Defense in depth: if the migration didn't run, create the row here.
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO workspace (id, name, icon) VALUES (1, 'My Workspace', '📋')"
    ).run();
    row = await c.env.DB.prepare('SELECT name, icon FROM workspace WHERE id = 1').first();
  }
  return c.json(row);
});

// 13. PUT /api/workspace — updates name and/or icon. Partial body.
app.put('/workspace', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const updates: string[] = [];
  const params: any[] = [];
  if (typeof body.name === 'string') {
    updates.push('name = ?');
    params.push(body.name.slice(0, 100));
  }
  if (typeof body.icon === 'string') {
    updates.push('icon = ?');
    params.push(body.icon.slice(0, 32));
  }
  if (updates.length === 0) {
    return c.json({ error: 'Nothing to update' }, 400);
  }
  updates.push(`updated_at = datetime('now')`);
  await c.env.DB.prepare(
    `UPDATE workspace SET ${updates.join(', ')} WHERE id = 1`
  ).bind(...params).run();
  const row: any = await c.env.DB.prepare('SELECT name, icon FROM workspace WHERE id = 1').first();
  return c.json(row);
});

export const onRequest = handle(app);
