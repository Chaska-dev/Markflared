-- Uploaded files. Binary payloads NEVER live in this table: R2 in production,
-- uploads/ on disk in local dev. `storage` records which backend owns the
-- bytes; everything else here is metadata.
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  storage TEXT NOT NULL DEFAULT 'r2',
  page_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_files_page ON files(page_id);
