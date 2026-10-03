// Local dev server: Express + SQLite. Functional replica of the Cloudflare
// Hono backend, for 100% local dev without wrangler/Cloudflare.
//
// Keeps exactly the same HTTP contract (routes, request/response shapes)
// as the Hono backend, so the frontend doesn't notice the difference.

import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { db, runMigrations, normalizeBlock, Row } from './db';
import {
  loadAuthEnv,
  issueToken,
  verifyToken,
  checkRate,
  clientIp,
  timingSafeEqual,
  AuthEnv,
} from './auth';
import { parseMarkdownToBlocks } from './shared/markdown';

// Bootstrap

const authEnv = loadAuthEnv();
if (!authEnv) {
  console.error('[server] Missing AUTH_USERNAME / AUTH_PASSWORD / AUTH_SECRET.');
  console.error('[server] Create a .dev.vars in the project root with:');
  console.error('  AUTH_USERNAME=admin');
  console.error('  AUTH_PASSWORD=admin');
  console.error('  AUTH_SECRET=any-long-string-here');
  process.exit(1);
}

const migResult = runMigrations();
if (migResult.applied.length > 0) {
  console.log(`[server] migrations applied: ${migResult.applied.join(', ')}`);
}
if (migResult.skipped.length > 0) {
  console.log(`[server] migrations already applied: ${migResult.skipped.join(', ')}`);
}

// Multer in-memory: 10MB max, same as the Hono backend limit.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const app = express();
app.use(express.json({ limit: '2mb' }));
// To serve dist/ from the same port ("everything on :3000"), uncomment and
// open :3000 instead of :5173:
// app.use(express.static(path.resolve(process.cwd(), 'dist')));

// Helpers

// Is `candidate` a descendant of `ancestor`? Capped at 64 hops.
function isDescendantBlock(candidate: string, ancestor: string): boolean {
  let current: string | null = candidate;
  for (let i = 0; i < 64; i++) {
    if (!current) return false;
    if (current === ancestor) return true;
    const row: any = db.prepare('SELECT parent_id FROM blocks WHERE id = ?').get(current);
    if (!row) return false;
    current = row.parent_id || null;
  }
  return false;
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header('Authorization') || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = header.slice('Bearer '.length).trim();
  verifyToken(token, authEnv.username, authEnv.secret).then(v => {
    if (!v.ok) return res.status(401).json({ error: v.expired ? 'Session expired' : 'Unauthorized' });
    if (v.isApi && v.tokenId) {
      const row = db.prepare('SELECT id FROM api_tokens WHERE id = ?').get(v.tokenId);
      if (!row) {
        return res.status(401).json({ error: 'Token has been revoked' });
      }
    }
    next();
  }).catch(() => res.status(401).json({ error: 'Unauthorized' }));
}

// Routes

app.post('/api/auth/login', async (req: Request, res: Response) => {
  const ip = clientIp(req);
  if (!checkRate(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
  const body = req.body || {};
  const { username, password } = body;
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Invalid credentials' });
  }
  if (username.length > 128 || password.length > 1024) {
    return res.status(400).json({ error: 'Invalid credentials' });
  }
  const uOk = timingSafeEqual(username, authEnv.username);
  const pOk = timingSafeEqual(password, authEnv.password);
  if (!uOk || !pOk) {
    console.warn(`[auth] login failed ip=${ip}`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const { token, expiresAt } = await issueToken(authEnv.username, authEnv.secret);
  return res.json({ token, username: authEnv.username, expiresAt });
});

// API Token management endpoints (auth-gated)

// POST /api/auth/token — generates a dedicated long-lived token for MCP / external tools
app.post('/api/auth/token', requireAuth, async (req: Request, res: Response) => {
  const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 100) : 'MCP Token';
  const expiresInDays = Number(req.body?.expiresInDays) || 365;
  const ttlMs = expiresInDays * 24 * 60 * 60 * 1000;
  const id = crypto.randomUUID();
  const { token, expiresAt } = await issueToken(authEnv.username, authEnv.secret, ttlMs, id);
  db.prepare('INSERT INTO api_tokens (id, name, token, expires_at) VALUES (?, ?, ?, ?)').run(id, name, token, expiresAt);
  const row: any = db.prepare('SELECT id, name, token, created_at, expires_at FROM api_tokens WHERE id = ?').get(id);
  return res.json({ id: row.id, name: row.name, token: row.token, expiresAt: row.expires_at, createdAt: row.created_at });
});

// GET /api/auth/tokens — lists all active API tokens
app.get('/api/auth/tokens', requireAuth, (req: Request, res: Response) => {
  const rows: any[] = db.prepare('SELECT id, name, token, created_at, expires_at FROM api_tokens ORDER BY created_at DESC').all();
  const tokens = rows.map(r => ({
    id: r.id,
    name: r.name,
    tokenPreview: r.token.length > 24 ? `${r.token.slice(0, 12)}...${r.token.slice(-8)}` : r.token,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));
  return res.json({ tokens });
});

// DELETE /api/auth/tokens/:id — revokes/deletes an API token
app.delete('/api/auth/tokens/:id', requireAuth, (req: Request, res: Response) => {
  const id = req.params.id;
  db.prepare('DELETE FROM api_tokens WHERE id = ?').run(id);
  return res.json({ success: true, id });
});

// Public share endpoints (NO auth required).
// Anyone with the link can view the shared page and all its descendants.
// The client decides what to render (split layout in our case). Since these
// routes don't match /api/pages, /api/blocks, etc., the auth middleware
// below doesn't intercept them — they're public by design.

// Generate a URL-safe 128-bit token (16 bytes base64url = 22 chars).
// Enough entropy to be unguessable; URL-safe so no escaping needed in the bar.
function generateShareToken(): string {
  return crypto.randomBytes(16).toString('base64url');
}

// Look up the share root by token. Returns null if the token doesn't exist
// or the share was revoked. Does not check descendants — each endpoint does
// that itself as needed.
function findShareRoot(token: string): any | null {
  const row: any = db
    .prepare('SELECT page_id FROM page_shares WHERE token = ? AND revoked = 0')
    .get(token);
  if (!row) return null;
  return db.prepare('SELECT * FROM pages WHERE id = ?').get(row.page_id);
}

// GET /api/share/:token — public tree of the shared page.
// Returns the root + flat list of descendants; the frontend builds the tree
// with the same logic as `buildPageTree` (consistency between authed and
// public views).
app.get('/api/share/:token', (req, res) => {
  const token = req.params.token;
  const root = findShareRoot(token);
  if (!root) return res.status(404).json({ error: 'Link not found or disabled' });

  const ids = collectDescendantPageIds(root.id);
  const placeholders = ids.map(() => '?').join(',');
  const pages = db
    .prepare(`SELECT * FROM pages WHERE id IN (${placeholders}) ORDER BY position ASC, created_at ASC`)
    .all(...ids);
  res.json({ root, pages });
});

// GET /api/share/:token/page/:pageId — content (page + blocks) of a page
// inside the share. We validate that pageId is a descendant of root so a
// visitor can't request any workspace page with a valid token (defense
// against enumeration).
app.get('/api/share/:token/page/:pageId', (req, res) => {
  const token = req.params.token;
  const pageId = req.params.pageId;
  const root = findShareRoot(token);
  if (!root) return res.status(404).json({ error: 'Link not found or disabled' });

  const allowedIds = collectDescendantPageIds(root.id);
  if (!allowedIds.includes(pageId)) {
    return res.status(403).json({ error: 'Page outside the shared link' });
  }

  const page: any = db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  const blocks = db
    .prepare('SELECT * FROM blocks WHERE page_id = ? ORDER BY position ASC')
    .all(pageId)
    .map((b: any) => normalizeBlock(b));
  res.json({ page, blocks });
});

// Auth-gated: everything below requires a Bearer token.
app.use('/api/pages', requireAuth);
app.use('/api/blocks', requireAuth);
app.use('/api/files/upload', requireAuth);
app.use('/api/workspace', requireAuth);

// GET /api/workspace — returns the singleton with the current name and icon.
app.get('/api/workspace', (_req, res) => {
  let row: any = db.prepare('SELECT name, icon FROM workspace WHERE id = 1').get();
  if (!row) {
    // Defense in depth: if the migration didn't run for some reason, create
    // the row here with defaults. Idempotent.
    db.prepare(
      "INSERT OR IGNORE INTO workspace (id, name, icon) VALUES (1, 'My Workspace', '📋')"
    ).run();
    row = db.prepare('SELECT name, icon FROM workspace WHERE id = 1').get();
  }
  res.json(row);
});

// PUT /api/workspace — updates name and/or icon. Partial body accepted.
app.put('/api/workspace', (req, res) => {
  const body = req.body || {};
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
    return res.status(400).json({ error: 'Nothing to update' });
  }
  updates.push(`updated_at = datetime('now')`);
  db.prepare(`UPDATE workspace SET ${updates.join(', ')} WHERE id = 1`).run(...params);
  const row: any = db.prepare('SELECT name, icon FROM workspace WHERE id = 1').get();
  res.json(row);
});

// Share management (auth-gated) — endpoints for the page owner to create,
// query, and deactivate the page's public link. Each page has at most ONE
// active share at a time (page_id is the PK).

// POST /api/pages/:id/share — activates the share. If a revoked one already
// existed, reuse the slot (same PK) and generate a new token. Otherwise
// create the row with revoked=0.
app.post('/api/pages/:id/share', (req, res) => {
  const pageId = req.params.id;
  const page: any = db.prepare('SELECT id FROM pages WHERE id = ?').get(pageId);
  if (!page) return res.status(404).json({ error: 'Page not found' });

  const existing: any = db.prepare('SELECT token, revoked FROM page_shares WHERE page_id = ?').get(pageId);
  // Always generate a new token on activation so a "stale" share that gets
  // re-activated doesn't keep the old link (safer: if someone had the old
  // link and it was deactivated, re-activation should yield a new link).
  const token = generateShareToken();
  if (existing) {
    db.prepare('UPDATE page_shares SET token = ?, revoked = 0, created_at = datetime(\'now\') WHERE page_id = ?')
      .run(token, pageId);
  } else {
    db.prepare('INSERT INTO page_shares (page_id, token, revoked) VALUES (?, ?, 0)')
      .run(pageId, token);
  }
  res.json({ token, revoked: false, created_at: new Date().toISOString() });
});

// GET /api/pages/:id/share — returns share info if active, or 404.
app.get('/api/pages/:id/share', (req, res) => {
  const pageId = req.params.id;
  const row: any = db
    .prepare('SELECT token, revoked, created_at FROM page_shares WHERE page_id = ? AND revoked = 0')
    .get(pageId);
  if (!row) return res.status(404).json({ error: 'No active share' });
  res.json({ ...row, revoked: Boolean(row.revoked) });
});

// DELETE /api/pages/:id/share — revokes the share. Keeps the row (we don't
// delete) so a future POST reuses the slot instead of creating another.
app.delete('/api/pages/:id/share', (req, res) => {
  const pageId = req.params.id;
  const info = db.prepare('UPDATE page_shares SET revoked = 1 WHERE page_id = ?').run(pageId);
  res.json({ success: true, changed: info.changes });
});

// 1. GET /api/pages
app.get('/api/pages', (_req, res) => {
  const pages = db.prepare('SELECT * FROM pages ORDER BY position ASC, created_at DESC').all();
  res.json({ pages });
});

// 2. POST /api/pages
app.post('/api/pages', (req, res) => {
  const body = req.body || {};
  const id = crypto.randomUUID();
  const title = typeof body.title === 'string' ? body.title.slice(0, 500) : 'Untitled';
  const icon = typeof body.icon === 'string' ? body.icon.slice(0, 32) : '📄';
  const parent_id = typeof body.parent_id === 'string' ? body.parent_id : null;
  const position = Number.isFinite(body.position) ? Number(body.position) : 0;

  const insertPage = db.prepare(
    'INSERT INTO pages (id, title, icon, parent_id, position) VALUES (?, ?, ?, ?, ?)'
  );
  const insertBlock = db.prepare(
    'INSERT INTO blocks (id, page_id, type, content, position) VALUES (?, ?, ?, ?, ?)'
  );
  const tx = db.transaction(() => {
    insertPage.run(id, title, icon, parent_id, position);
    insertBlock.run(crypto.randomUUID(), id, 'paragraph', '', 0);
  });
  tx();
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(id);
  res.json({ page });
});

// 2.5 POST /api/pages/import
app.post('/api/pages/import', (req, res) => {
  const body = req.body || {};
  const markdown = typeof body.markdown === 'string' ? body.markdown : '';
  const safeTitle = typeof body.title === 'string' ? body.title.slice(0, 500) : 'Imported';
  const safeParent = typeof body.parent_id === 'string' ? body.parent_id : null;

  const { blocks, detectedTitle } = parseMarkdownToBlocks(markdown, safeTitle);
  const pageTitle = detectedTitle || safeTitle || 'Imported';
  const id = crypto.randomUUID();

  const insertPage = db.prepare(
    'INSERT INTO pages (id, title, icon, parent_id, position) VALUES (?, ?, ?, ?, 0)'
  );
  const insertBlock = db.prepare(
    'INSERT INTO blocks (id, page_id, type, content, checked, position, language) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const tx = db.transaction(() => {
    insertPage.run(id, pageTitle, '📄', safeParent);
    blocks.forEach((b, idx) => {
      insertBlock.run(crypto.randomUUID(), id, b.type, b.content, b.checked ? 1 : 0, idx * 1000, b.language || '');
    });
  });
  tx();
  const page: any = db.prepare('SELECT * FROM pages WHERE id = ?').get(id);
  const insertedBlocks = db.prepare(
    'SELECT * FROM blocks WHERE page_id = ? ORDER BY position ASC'
  ).all(id).map(normalizeBlock);
  page.blocks = insertedBlocks;
  res.json({ page });
});

// 3. GET /api/pages/:id
app.get('/api/pages/:id', (req, res) => {
  const id = req.params.id;
  const page: any = db.prepare('SELECT * FROM pages WHERE id = ?').get(id);
  if (!page) return res.status(404).json({ error: 'Not found' });
  const blocks = db.prepare(
    'SELECT * FROM blocks WHERE page_id = ? ORDER BY position ASC'
  ).all(id).map(normalizeBlock);
  res.json({ page: { ...page, blocks } });
});

// 3.5 GET /api/pages/:id/export
app.get('/api/pages/:id/export', (req, res) => {
  const id = req.params.id;
  const page: any = db.prepare('SELECT * FROM pages WHERE id = ?').get(id);
  if (!page) return res.status(404).json({ error: 'Not found' });
  const blocks: any[] = db.prepare(
    'SELECT * FROM blocks WHERE page_id = ? ORDER BY position ASC'
  ).all(id);

  let markdown = '';
  let numberedListCount = 1;
  for (const block of blocks) {
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
  res.json({ markdown: markdown.trim(), title: page.title });
});

// 4. PUT /api/pages/:id
app.put('/api/pages/:id', (req, res) => {
  const id = req.params.id;
  const body = req.body || {};
  const updates: string[] = [];
  const params: any[] = [];
  if (typeof body.title === 'string') { updates.push('title = ?'); params.push(body.title.slice(0, 500)); }
  if (typeof body.icon === 'string') { updates.push('icon = ?'); params.push(body.icon.slice(0, 32)); }
  if (body.parent_id === null || typeof body.parent_id === 'string') { updates.push('parent_id = ?'); params.push(body.parent_id); }
  if (Number.isFinite(body.position)) { updates.push('position = ?'); params.push(Number(body.position)); }

  if (updates.length > 0) {
    updates.push(`updated_at = datetime('now')`);
    params.push(id);
    db.prepare(`UPDATE pages SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(id);
  res.json({ page });
});

// 5. DELETE /api/pages/:id
app.delete('/api/pages/:id', (req, res) => {
  const id = req.params.id;
  const pageIds = collectDescendantPageIds(id);
  // Delete blocks of all descendant pages, then the pages themselves, in a
  // single transaction so we never leave orphans.
  //
  // Also clean up subpage blocks that live in OTHER pages but reference one
  // of the deleted pages (subpage blocks store the referenced page id in
  // `content`). Without this, deleting a page leaves dangling subpage
  // blocks in the parent documents that point to a no-longer-existing
  // page. Subpages are intentionally not deletable inline, so removing
  // the page is the only way for those references to disappear.
  const deleteBlocks = db.prepare('DELETE FROM blocks WHERE page_id = ?');
  const deleteOrphanSubpageRefs = db.prepare(
    `DELETE FROM blocks WHERE type = 'subpage' AND content IN (${pageIds.map(() => '?').join(',') || "''"})`
  );
  const deletePage = db.prepare('DELETE FROM pages WHERE id = ?');

  // Files come from two sources, same as the Pages function: the rows attached
  // to these pages, plus image/file blocks pointing at a stored file by ID. The
  // bytes on disk have to go too — files.page_id is ON DELETE SET NULL, so
  // deleting the page alone would strand them forever.
  const inList = pageIds.map(() => '?').join(',') || "''";
  const byPage = db.prepare(`SELECT id FROM files WHERE page_id IN (${inList})`).all(...pageIds) as any[];
  const byBlock = db.prepare(
    `SELECT content FROM blocks WHERE type IN ('image', 'file') AND page_id IN (${inList})`
  ).all(...pageIds) as any[];
  const fileIds = new Set<string>();
  for (const row of byPage) fileIds.add(row.id);
  for (const row of byBlock) {
    // A block can hold an http(s) URL or a data: URI instead of a stored file —
    // only bare UUIDs are storage keys.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.content || '')) {
      fileIds.add(row.content);
    }
  }
  const deleteFile = db.prepare('DELETE FROM files WHERE id = ?');

  const tx = db.transaction((ids: string[]) => {
    deleteOrphanSubpageRefs.run(...ids);
    for (const pid of ids) deleteBlocks.run(pid);
    for (const fid of fileIds) deleteFile.run(fid);
    for (const pid of ids) deletePage.run(pid);
  });
  tx(pageIds);

  // Unlink only after the transaction commits: a rollback must not leave rows
  // pointing at bytes that are already gone.
  for (const fid of fileIds) {
    const filePath = path.join(uploadsDir, fid);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  res.json({ success: true, deletedPages: pageIds.length, deletedFiles: fileIds.size });
});

// 5b. GET /api/pages/:id/cascade-count — how many subpages and blocks would
// be deleted if this page were deleted (does not delete anything). Useful to
// show the real scope in a confirm before running the delete.
app.get('/api/pages/:id/cascade-count', (req, res) => {
  const id = req.params.id;
  const pageIds = collectDescendantPageIds(id);
  const blocksCount = db.prepare(
    `SELECT COUNT(*) AS n FROM blocks WHERE page_id IN (${pageIds.map(() => '?').join(',')})`
  ).get(...pageIds) as { n: number };
  res.json({ pages: pageIds.length, blocks: blocksCount.n });
});

// Collect all descendant page ids (including the root) by walking the tree
// via parent_id. Used by the cascade DELETE and the count endpoint.
function collectDescendantPageIds(rootId: string): string[] {
  const result: string[] = [];
  const queue: string[] = [rootId];
  const getChildren = db.prepare('SELECT id FROM pages WHERE parent_id = ?');
  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);
    const kids = getChildren.all(current) as { id: string }[];
    for (const k of kids) queue.push(k.id);
  }
  return result;
}

// 6. POST /api/pages/:pageId/blocks
app.post('/api/pages/:pageId/blocks', (req, res) => {
  const pageId = req.params.pageId;
  const body = req.body || {};
  const id = crypto.randomUUID();

  const type = typeof body.type === 'string' ? body.type.slice(0, 32) : 'paragraph';
  const content = typeof body.content === 'string' ? body.content : '';
  const position = Number.isFinite(body.position) ? Number(body.position) : 0;
  const language = typeof body.language === 'string' ? body.language.slice(0, 100) : '';

  let parent_id: string | null = null;
  if (typeof body.parent_id === 'string' && body.parent_id.length > 0) {
    const parentCheck: any = db.prepare('SELECT id, page_id FROM blocks WHERE id = ?').get(body.parent_id);
    if (parentCheck && parentCheck.page_id === pageId) {
      parent_id = parentCheck.id;
    }
  }
  db.prepare(
    'INSERT INTO blocks (id, page_id, type, content, position, parent_id, language) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, pageId, type, content, position, parent_id, language);

  const block = db.prepare('SELECT * FROM blocks WHERE id = ?').get(id);
  res.json({ block: normalizeBlock(block) });
});

// 7. PUT /api/blocks/:id
app.put('/api/blocks/:id', (req, res) => {
  const id = req.params.id;
  const body = req.body || {};
  const updates: string[] = [];
  const params: any[] = [];

  if (typeof body.content === 'string') { updates.push('content = ?'); params.push(body.content); }
  if (typeof body.type === 'string') { updates.push('type = ?'); params.push(body.type.slice(0, 32)); }
  if (typeof body.checked === 'boolean') { updates.push('checked = ?'); params.push(body.checked ? 1 : 0); }
  if (typeof body.language === 'string') { updates.push('language = ?'); params.push(body.language.slice(0, 32)); }
  if (Number.isFinite(body.position)) { updates.push('position = ?'); params.push(Number(body.position)); }
  if (body.parent_id === null) {
    updates.push('parent_id = ?'); params.push(null);
  } else if (typeof body.parent_id === 'string' && body.parent_id.length > 0) {
    const parentCheck: any = db.prepare('SELECT id, page_id FROM blocks WHERE id = ?').get(body.parent_id);
    if (parentCheck && !isDescendantBlock(body.parent_id, id)) {
      updates.push('parent_id = ?'); params.push(body.parent_id);
    }
  }
  if (typeof body.collapsed === 'boolean') {
    updates.push('collapsed = ?'); params.push(body.collapsed ? 1 : 0);
  }

  if (updates.length > 0) {
    updates.push(`updated_at = datetime('now')`);
    params.push(id);
    db.prepare(`UPDATE blocks SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  const block = db.prepare('SELECT * FROM blocks WHERE id = ?').get(id);
  res.json({ block: normalizeBlock(block) });
});

// 8. DELETE /api/blocks/:id
app.delete('/api/blocks/:id', (req, res) => {
  const id = req.params.id;
  db.prepare('DELETE FROM blocks WHERE id = ?').run(id);
  res.json({ success: true });
});

// 9. PUT /api/blocks/reorder
app.put('/api/blocks/reorder', (req, res) => {
  const body = req.body || {};
  const list: any[] = Array.isArray(body.blocks) ? body.blocks : [];
  const safe = list
    .filter((b: any) => b && typeof b === 'object' && typeof b.id === 'string' && Number.isFinite(b.position))
    .map((b: any) => ({ id: b.id, position: Number(b.position) }));

  try {
    const stmt = db.prepare('UPDATE blocks SET position = ?, updated_at = datetime(\'now\') WHERE id = ?');
    const tx = db.transaction(() => {
      for (const b of safe) stmt.run(b.position, b.id);
    });
    tx();
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

// 9b. GET /api/search — global search by pages and block content.
app.get('/api/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [] });

  const pattern = `%${q}%`;

  const matchedPages: any[] = db.prepare(
    'SELECT id, title, icon, updated_at FROM pages WHERE title LIKE ? ORDER BY updated_at DESC LIMIT 10'
  ).all(pattern);

  const matchedBlocks: any[] = db.prepare(
    `SELECT b.id, b.page_id, b.content, b.type, b.updated_at, p.title as page_title, p.icon as page_icon
     FROM blocks b
     JOIN pages p ON b.page_id = p.id
     WHERE b.content LIKE ? AND b.type NOT IN ('divider', 'subpage')
     ORDER BY b.updated_at DESC LIMIT 25`
  ).all(pattern);

  const results: any[] = [];

  for (const p of matchedPages) {
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

  for (const b of matchedBlocks) {
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

  res.json({ results });
});

const uploadsDir = path.resolve(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// 10. POST /api/files/upload (multipart with multer + disk storage).
app.post('/api/files/upload', requireAuth, upload.single('file'), (req, res) => {
  const file = (req as any).file as Express.Multer.File | undefined;
  const pageId = (req.body?.page_id as string | undefined) || null;
  if (!file) return res.status(400).json({ error: 'No file' });

  const id = crypto.randomUUID();
  const filePath = path.join(uploadsDir, id);
  fs.writeFileSync(filePath, file.buffer);

  db.prepare(
    'INSERT INTO files (id, name, mime_type, size, storage, page_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, file.originalname.slice(0, 255), file.mimetype.slice(0, 128), file.size, 'disk', pageId);

  const row: any = db.prepare(
    'SELECT id, name, mime_type, size, page_id, created_at FROM files WHERE id = ?'
  ).get(id);
  row.url = `/api/files/${id}`;
  res.json({ file: row });
});

// 11. GET /api/files/:id — serves from uploads/ on disk. No base64 fallback:
// local dev mirrors the production path, which reads bytes from object storage.
app.get('/api/files/:id', (req, res) => {
  const id = req.params.id;
  const filePath = path.join(uploadsDir, id);

  const file: any = db.prepare('SELECT id, mime_type FROM files WHERE id = ?').get(id);
  if (!file) return res.status(404).json({ error: 'Not found' });

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File data missing' });
  }

  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  return res.sendFile(filePath);
});

// Listen

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT} (auth: ${authEnv.username}/***)`);
});
