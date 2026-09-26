// Local SQLite + migration runner. Uses better-sqlite3 (sync API, prebuilt
// Windows binaries). The DB file lives at data/markflare.db (gitignored).

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = process.env.markflare_DB_PATH || path.join(DATA_DIR, 'markflare.db');
const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Row types returned by db.prepare(...).all(). Kept loose because each table
// has its own shape; services use `any` and normalize at the shared layer.
export type Row = Record<string, any>;

// Apply ALL migrations in lexicographic order. Each file runs in a
// transaction. Idempotent at the file level (CREATE TABLE/INDEX use IF NOT
// EXISTS; ALTER TABLE on existing columns fails silently because D1 doesn't
// have DROP COLUMN, so re-running them is a no-op).
export function runMigrations(): { applied: string[]; skipped: string[] } {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.warn(`[db] missing ${MIGRATIONS_DIR}, skipping migrations`);
    return { applied: [], skipped: [] };
  }
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  // Bookkeeping table to avoid re-applying migrations.
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations_applied (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied: string[] = [];
  const skipped: string[] = [];
  const alreadyApplied = new Set(
    db.prepare('SELECT name FROM _migrations_applied').all().map((r: any) => r.name)
  );

  for (const file of files) {
    if (alreadyApplied.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations_applied (name) VALUES (?)').run(file);
    });
    try {
      tx();
      applied.push(file);
    } catch (e: any) {
      // If the error is for duplicate columns/indexes, log it but keep going.
      // For anything else, propagate.
      const msg = String(e?.message || e);
      if (/duplicate column|already exists/i.test(msg)) {
        db.prepare('INSERT OR IGNORE INTO _migrations_applied (name) VALUES (?)').run(file);
        skipped.push(file);
      } else {
        throw e;
      }
    }
  }
  return { applied, skipped };
}

// Helper: converts `checked` (which SQLite stores as 0/1) to boolean. Used
// by every endpoint that returns blocks.
export function normalizeBlock(b: Row | undefined): Row | undefined {
  if (!b) return b;
  return { ...b, checked: Boolean(b.checked), collapsed: Boolean(b.collapsed) };
}
