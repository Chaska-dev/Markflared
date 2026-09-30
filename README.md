<div align="center">
  <img src="public/logo.svg" alt="Markflare logo" width="220" />
</div>

A self-hosted, block-based note-taking workspace on **Cloudflare Pages + D1**.
Pages, subpages, todos, code blocks, tables, public share links, file uploads and bilingual UI (EN/ES). Runs on Cloudflare in production, Express + SQLite for local dev.

---

## Stack

- **Frontend** — React 18 + Vite 5 + TypeScript
- **Backend** — Cloudflare Pages Functions (Hono) · Express 5 (local dev)
- **DB** — Cloudflare D1 (prod) · `better-sqlite3` (local)
- **AI / MCP** — Official Model Context Protocol Server (`@modelcontextprotocol/sdk`)

## Run locally

```bash
git clone https://github.com/<your-user>/markflare.git
cd markflare
pnpm install
cp .env.example .dev.vars   # set AUTH_USERNAME, AUTH_PASSWORD, AUTH_SECRET
pnpm run db:migrate:all     # creates data/markflare.db with the schema
pnpm run dev                # Express on :3000 + Vite on :5173
```

Open <http://localhost:5173> and sign in with the credentials in `.dev.vars`.

---

## Model Context Protocol (MCP)

Markflare includes a built-in **MCP server** allowing AI assistants (Claude Desktop, Cursor, Zed, Antigravity) to manage your workspace:

- Import Markdown content & `.md` files directly into pages.
- List workspace pages & inspect hierarchy.
- Search pages and blocks.

```bash
pnpm run mcp        # Start MCP server on stdio
pnpm run test:mcp   # Run end-to-end MCP test suite
```

See the [MCP Documentation & Examples](mcp/README.md) for client configuration guides.

---

## Deploy

Markflare can be deployed in four different ways. Pick the one that matches your workflow.

> **Note** — there's no `wrangler.toml` in this repo on purpose. Cloudflare Pages will manage everything from the dashboard: build command, build output directory, D1 binding, and `AUTH_*` secrets. (Putting any of those in `wrangler.toml` locks the dashboard's binding UI.) If you want to use Method 4 (terminal `wrangler`), create a local `wrangler.toml` for that workflow — see Method 4 for the snippet.

| | Local dev | Dashboard (no terminal) | Terminal (`wrangler`) |
|---|---|---|---|
| **Method** | 1. Local development | 2. Clone repo · 3. Download ZIP · 5. Git-connected | 4. `wrangler` CLI |
| **Build** | `pnpm run dev` | local (2/3) or auto on Pages (5) | `pnpm run deploy` |
| **Migrations** | `pnpm run db:migrate:all` | paste each block in the D1 Console | `pnpm run db:migrate:prod` |
| **D1 binding** | local SQLite file | set in the Pages UI | set in local `wrangler.toml` |
| **AUTH secrets** | `.dev.vars` locally | set in the Pages UI | set in the Pages UI |

1. [Local development](#1-local-development) — runs on your machine, no deploy needed
2. [Dashboard — clone the repo](#2-dashboard--clone-the-repo) — recommended for developers
3. [Dashboard — download as ZIP](#3-dashboard--download-as-zip) — no git required
4. [Terminal — `wrangler` CLI](#4-terminal--wrangler-cli) — script everything
5. [Dashboard — Git-connected deploy](#5-dashboard--git-connected-deploy) — push to GitHub, Pages builds for you

### 1. Local development

Already covered above (`pnpm run dev`). The local Express server talks to a SQLite file at `data/markflare.db`, so you don't need a D1 database at all.

---

### 2. Dashboard — clone the repo

This is the cleanest path: clone the repo with `git`, build locally, and upload `dist/`. No `wrangler` CLI required.

#### 2.1. Clone and build

```bash
git clone https://github.com/<your-user>/markflare.git
cd markflare
pnpm install
pnpm run build
```

This produces `dist/`. Cloning (instead of downloading a ZIP) keeps your local copy a clean snapshot of the source — you'll always rebuild from the same code without surprises.

#### 2.2. Create the D1 database

**Workers & Pages → D1 SQL databases → Create database**

- Name: `markflare-db`

#### 2.3. Apply the migrations

Open the D1 database page → **Console** tab. Paste each block below and hit **Execute** in order.

**Block 1 — `0001_initial.sql`. Paste and Execute:**

```sql
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Untitled',
  icon TEXT NOT NULL DEFAULT '📄',
  parent_id TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (parent_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'paragraph',
  content TEXT NOT NULL DEFAULT '',
  checked INTEGER NOT NULL DEFAULT 0,
  language TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  parent_id TEXT,
  collapsed INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_id);
CREATE INDEX IF NOT EXISTS idx_blocks_page ON blocks(page_id);
CREATE INDEX IF NOT EXISTS idx_blocks_position ON blocks(page_id, position);
```

**Block 2 — `0002_files.sql`. Paste and Execute:**

```sql
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
```

**Block 3 — `0003_workspace.sql`. Paste and Execute:**

```sql
CREATE TABLE IF NOT EXISTS workspace (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'My Workspace',
  icon TEXT NOT NULL DEFAULT '📋',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO workspace (id, name, icon) VALUES (1, 'My Workspace', '📋');
```

**Block 4 — `0004_shares.sql`. Paste and Execute:**

```sql
CREATE TABLE IF NOT EXISTS page_shares (
  page_id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_page_shares_token ON page_shares(token);
```

All blocks use `IF NOT EXISTS` everywhere, so re-running is safe.

#### 2.4. Create the Pages project

**Workers & Pages → Create application → Pages → Upload assets**

- Project name: `markflare`
- Production branch name: `main`
- Drag the `dist/` folder onto the upload area

Cloudflare will build nothing — `dist/` is already the final SPA. The `functions/api/[[route]].ts` file is automatically detected and deployed as a Pages Function (your Worker).

#### 2.5. Configure the Pages project

In **Settings → Functions**:

- **Compatibility date** → `2024-09-01`
- **D1 database bindings → Add**:
  - Variable name: `DB`
  - D1 database: `markflare-db` (the one from step 2.2)

In **Settings → Variables and secrets → Add** (Encrypt type, not Plaintext):

| Variable         | Value                                                          |
| ---------------- | -------------------------------------------------------------- |
| `AUTH_USERNAME`  | your username                                                  |
| `AUTH_PASSWORD`  | your password                                                  |
| `AUTH_SECRET`    | a long random string (rotate to invalidate all sessions)       |

Generate `AUTH_SECRET` with `openssl rand -hex 32`.

> **Heads-up**: Pages injects these secrets into the Worker on the **next deploy**. If you just added them and login fails with `503`, trigger a redeploy (push any commit or click "Retry deployment" on the latest build).

Your site is live at `https://markflare.pages.dev` (or whatever the assigned `*.pages.dev` URL is).

#### 2.6. Custom domain (optional)

**Custom domains → Set up a custom domain** → follow the prompts. Cloudflare auto-issues the cert.

---

### 3. Dashboard — download as ZIP

Same end result as Method 2, but you skip `git` and grab the source as a ZIP. Useful if you don't have git set up or just want to deploy once.

#### 3.1. Download and build

1. Go to `https://github.com/<your-user>/markflare`.
2. Click **Code → Download ZIP**.
3. Extract the ZIP somewhere on your machine.
4. Open a terminal in the extracted folder and run:

```bash
pnpm install
pnpm run build
```

This produces `dist/`. You'll upload it in step 3.4.

#### 3.2. Create the D1 database

**Workers & Pages → D1 SQL databases → Create database**

- Name: `markflare-db`

#### 3.3. Apply the migrations

Open the D1 database page → **Console** tab. Paste each block below and hit **Execute** in order.

**Block 1 — `0001_initial.sql`. Paste and Execute:**

```sql
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Untitled',
  icon TEXT NOT NULL DEFAULT '📄',
  parent_id TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (parent_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'paragraph',
  content TEXT NOT NULL DEFAULT '',
  checked INTEGER NOT NULL DEFAULT 0,
  language TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  parent_id TEXT,
  collapsed INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_id);
CREATE INDEX IF NOT EXISTS idx_blocks_page ON blocks(page_id);
CREATE INDEX IF NOT EXISTS idx_blocks_position ON blocks(page_id, position);
```

**Block 2 — `0002_files.sql`. Paste and Execute:**

```sql
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
```

**Block 3 — `0003_workspace.sql`. Paste and Execute:**

```sql
CREATE TABLE IF NOT EXISTS workspace (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'My Workspace',
  icon TEXT NOT NULL DEFAULT '📋',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO workspace (id, name, icon) VALUES (1, 'My Workspace', '📋');
```

**Block 4 — `0004_shares.sql`. Paste and Execute:**

```sql
CREATE TABLE IF NOT EXISTS page_shares (
  page_id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_page_shares_token ON page_shares(token);
```

#### 3.4. Create the Pages project

**Workers & Pages → Create application → Pages → Upload assets**

- Project name: `markflare`
- Production branch name: `main`
- Drag the `dist/` folder onto the upload area

#### 3.5. Configure the Pages project

In **Settings → Functions**:

- **Compatibility date** → `2024-09-01`
- **D1 database bindings → Add**:
  - Variable name: `DB`
  - D1 database: `markflare-db`

In **Settings → Variables and secrets → Add** (Encrypt type, not Plaintext):

| Variable         | Value                                                          |
| ---------------- | -------------------------------------------------------------- |
| `AUTH_USERNAME`  | your username                                                  |
| `AUTH_PASSWORD`  | your password                                                  |
| `AUTH_SECRET`    | a long random string (rotate to invalidate all sessions)       |

Trigger a redeploy after adding the secrets so the Worker picks them up.

Your site is live at `https://markflare.pages.dev`.

#### 3.6. Custom domain (optional)

**Custom domains → Set up a custom domain** → follow the prompts.

---

### 4. Terminal — `wrangler` CLI

If you'd rather script the whole thing from a terminal:

> Method 4 needs a local `wrangler.toml` — but the repo intentionally doesn't have one (so the dashboard's binding UI stays free for Methods 2/3/5). You create one locally for this workflow and `.gitignore` it (or just don't commit it).

#### 4.1. Clone, install, and build

```bash
git clone https://github.com/<your-user>/markflare.git
cd markflare
pnpm install
pnpm run build
```

#### 4.2. Create the D1 database and grab its ID

**Workers & Pages → D1 SQL databases → Create database**

- Name: `markflare-db`
- After creation, click the database and copy the **Database ID** (UUID).

#### 4.3. Create a local `wrangler.toml`

In the project root, create `wrangler.toml` with:

```toml
name = "markflare"
compatibility_date = "2024-09-01"
pages_build_output_dir = "dist"

[[d1_databases]]
binding = "DB"
database_name = "markflare-db"
database_id = "PASTE-YOUR-D1-UUID-HERE"   # ← replace with the UUID from step 4.2
```

`pnpm run db:migrate:prod` and `wrangler pages deploy` both read this file. **Don't commit this file** — it has your D1 UUID which is project-specific.

#### 4.4. Apply the migrations

```bash
pnpm run db:migrate:prod
```

This runs `wrangler d1 migrations apply markflare-db --remote`, which reads every file in `migrations/` in lexicographic order and applies them in a single batch. Migrations are idempotent — `IF NOT EXISTS` everywhere — so re-running is safe.

#### 4.5. Deploy

```bash
pnpm run deploy
```

This runs `pnpm run build && wrangler pages deploy dist`. The Pages project is created on first deploy if it doesn't exist yet, and the D1 binding comes from `wrangler.toml`.

#### 4.6. Set the secrets

The deploy won't be functional yet — you still need the three `AUTH_*` secrets. Set them in the dashboard:

**Settings → Variables and secrets → Add** (Encrypt type):

| Variable         | Value                                                          |
| ---------------- | -------------------------------------------------------------- |
| `AUTH_USERNAME`  | your username                                                  |
| `AUTH_PASSWORD`  | your password                                                  |
| `AUTH_SECRET`    | a long random string                                           |

Your site is live at `https://markflare.pages.dev`.

#### 4.7. Custom domain (optional)

**Custom domains → Set up a custom domain** → follow the prompts.

---

### 5. Dashboard — Git-connected deploy

Push to GitHub and Cloudflare Pages builds + deploys automatically on every push. No local build step. The `packageManager: "pnpm@10.11.1"` field in `package.json` tells Corepack to use pnpm for the build, so this just works.

#### 5.1. Push the repo to GitHub

```bash
git remote add origin https://github.com/<your-user>/markflare.git
git push -u origin main
```

#### 5.2. Create the Pages project from Git

**Workers & Pages → Create application → Pages → Connect to Git**

- Select your GitHub account and the `markflare` repo.
- **Project name**: `markflare`
- **Production branch**: `main`

Cloudflare will show you a **Build configuration** screen. Set these explicitly:

- **Build command**: `pnpm run build` (must be set — leaving it blank makes Pages skip the build entirely, which fails because `functions/` references packages that need to be installed first)
- **Build output directory**: `dist`
- **Root directory**: leave blank

> The `packageManager: "pnpm@10.11.1"` field in `package.json` tells Corepack to use pnpm for the install step, but it does NOT auto-set the build command. You have to set it manually here.

#### 5.3. Create the D1 database

**Workers & Pages → D1 SQL databases → Create database**

- Name: `markflare-db`

#### 5.4. Apply the migrations

Open the D1 database page → **Console** tab. Paste each block below and hit **Execute** in order.

**Block 1 — `0001_initial.sql`. Paste and Execute:**

```sql
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Untitled',
  icon TEXT NOT NULL DEFAULT '📄',
  parent_id TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (parent_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'paragraph',
  content TEXT NOT NULL DEFAULT '',
  checked INTEGER NOT NULL DEFAULT 0,
  language TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  parent_id TEXT,
  collapsed INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_id);
CREATE INDEX IF NOT EXISTS idx_blocks_page ON blocks(page_id);
CREATE INDEX IF NOT EXISTS idx_blocks_position ON blocks(page_id, position);
```

**Block 2 — `0002_files.sql`. Paste and Execute:**

```sql
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
```

**Block 3 — `0003_workspace.sql`. Paste and Execute:**

```sql
CREATE TABLE IF NOT EXISTS workspace (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'My Workspace',
  icon TEXT NOT NULL DEFAULT '📋',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO workspace (id, name, icon) VALUES (1, 'My Workspace', '📋');
```

**Block 4 — `0004_shares.sql`. Paste and Execute:**

```sql
CREATE TABLE IF NOT EXISTS page_shares (
  page_id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_page_shares_token ON page_shares(token);
```

#### 5.5. Configure the Pages project

In **Settings → Functions**:

- **Compatibility date** → `2024-09-01`
- **D1 database bindings → Add**:
  - Variable name: `DB`
  - D1 database: `markflare-db` (the one from step 5.3)

In **Settings → Variables and secrets → Add** (Encrypt type, not Plaintext):

| Variable         | Value                                                          |
| ---------------- | -------------------------------------------------------------- |
| `AUTH_USERNAME`  | your username                                                  |
| `AUTH_PASSWORD`  | your password                                                  |
| `AUTH_SECRET`    | a long random string (rotate to invalidate all sessions)       |

> **Heads-up**: Pages injects these secrets into the Worker on the **next deploy**. If you just added them and login fails with `503`, trigger a redeploy (push any commit or click "Retry deployment" on the latest build).

#### 5.6. Wait for the build

Cloudflare starts the build automatically when you push. Watch the **Deployments** tab — if it goes red, the most common cause is the build command being blank (set it in Settings → Builds & deployments, then retry).

Your site is live at `https://markflare.pages.dev`.

#### 5.7. Custom domain (optional)

**Custom domains → Set up a custom domain** → follow the prompts.

---

## Migrations

All migrations live in `migrations/NNNN_*.sql`, run in lexicographic order, wrapped in a transaction per file.

| File                   | Adds                                                                  |
| ---------------------- | --------------------------------------------------------------------- |
| `0001_initial.sql`     | `pages`, `blocks` (with `parent_id` + `collapsed`), indexes          |
| `0002_files.sql`       | `files` table (base64 blobs)                                          |
| `0003_workspace.sql`   | `workspace` singleton (sidebar name + icon)                           |
| `0004_shares.sql`      | `page_shares` — public share tokens, with `revoked` tombstone column  |

> **D1 caveat** — SQLite has no `ADD COLUMN IF NOT EXISTS`, and D1 has no `DROP COLUMN`. Any future migration that changes a table shape should use the rebuild pattern: create `_<table>_new` with the new shape, `INSERT INTO _<table>_new SELECT ... FROM <table>`, `DROP TABLE <table>`, then `ALTER TABLE _<table>_new RENAME TO <table>`. Run that whole script in a transaction.

## API

All routes are mounted under `/api`. The 🔒 routes require a Bearer token from `POST /api/auth/login`.

| Method | Path                              | Auth | Purpose                                  |
| ------ | --------------------------------- | ---- | ---------------------------------------- |
| POST   | `/api/auth/login`                 | —    | Get a 24h bearer token                   |
| GET    | `/api/pages`                      | 🔒   | List all pages                           |
| POST   | `/api/pages`                      | 🔒   | Create a page                            |
| POST   | `/api/pages/import`               | 🔒   | Create a page from markdown              |
| GET    | `/api/pages/:id`                  | 🔒   | Page + ordered blocks                    |
| GET    | `/api/pages/:id/export`           | 🔒   | Export page as markdown                  |
| PUT    | `/api/pages/:id`                  | 🔒   | Update page                              |
| DELETE | `/api/pages/:id`                  | 🔒   | Cascade delete page + descendants        |
| POST   | `/api/pages/:id/blocks`           | 🔒   | Create a block                           |
| PUT    | `/api/blocks/:id`                 | 🔒   | Update a block (reparenting is cyclic-safe) |
| DELETE | `/api/blocks/:id`                 | 🔒   | Delete a block                           |
| PUT    | `/api/blocks/reorder`             | 🔒   | Batch reorder blocks                     |
| POST   | `/api/files/upload`               | 🔒   | Upload a file (≤ 10 MB, multipart)       |
| GET    | `/api/files/:id`                  | 🔒   | Stream a file                            |
| GET    | `/api/workspace`                  | 🔒   | Get sidebar name + icon                  |
| PUT    | `/api/workspace`                  | 🔒   | Update workspace                         |
| POST   | `/api/pages/:id/share`            | 🔒   | Activate a public share                  |
| GET    | `/api/pages/:id/share`            | 🔒   | Get active share                         |
| DELETE | `/api/pages/:id/share`            | 🔒   | Revoke a share                           |
| GET    | `/api/share/:token`               | —    | Public tree for a share                  |
| GET    | `/api/share/:token/page/:pageId`  | —    | Public page inside a share               |

## Configuration

A template is committed as `.env.example` at the repo root. Copy it to `.dev.vars` for local dev and fill in real values — `.dev.vars` is gitignored.

```bash
cp .env.example .dev.vars
# then edit .dev.vars with your real AUTH_USERNAME / AUTH_PASSWORD / AUTH_SECRET
```

| Variable        | Required | Description                                                  |
| --------------- | -------- | ------------------------------------------------------------ |
| `AUTH_USERNAME` | yes      | Single allowed username                                      |
| `AUTH_PASSWORD` | yes      | Single allowed password (use a strong one)                   |
| `AUTH_SECRET`   | yes      | Long random string for signing bearer tokens. Generate with `openssl rand -hex 32`. Rotating this value **invalidates every bearer token issued so far** — useful if a token ever leaks. |
| `markflare_DB_PATH`| no       | Override local SQLite path (default: `./data/markflare.db`)     |

**Local dev** — values are read from `.dev.vars` (gitignored) by both `wrangler pages dev` and the local Express server.

**Production** — set the same three `AUTH_*` values as **Encrypt**-type secrets in the Cloudflare dashboard under **Settings → Variables and secrets** on the Pages project.

## Notes

- **Auth** — single-user. 24h HMAC-SHA256 bearer tokens, constant-time comparisons, login rate-limited at 5/min/IP.
- **CORS** — same-origin only (frontend and `/api` live on the same host).
- **Foreign keys** — `PRAGMA foreign_keys = ON` is set on every D1 request; D1 connections start with FKs off by default.
- **Public shares** — 128-bit tokens, regenerated on every re-activation. Visitor requests are scoped to the share's descendant tree.

## Tech choices

- **pnpm** — package manager. We use pnpm instead of npm throughout (lockfile is `pnpm-lock.yaml`). Reasons: strict dependency resolution with no phantom deps, content-addressable store that saves disk space across projects, faster installs, and `pnpm.onlyBuiltDependencies` in `package.json` lets us whitelist the few packages that need build scripts (`better-sqlite3`, `esbuild`, `sharp`, `workerd`). To avoid the `npm install` failing on Cloudflare Pages when the project is pnpm-based, `package.json` declares `"packageManager": "pnpm@10.11.1"` — Corepack auto-detects pnpm and sets the right build command. Every command in this README is `pnpm ...`; never `npm ...`.

## License

MIT.
