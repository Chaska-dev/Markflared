-- Public share tokens: each row represents a page that has (or had) a public
-- link. `token` is the slug used in the `/share/:token` URL. `revoked=1`
-- means the link is deactivated, but we keep the row as a tombstone (and to
-- allow re-activation without regenerating the token). ON DELETE CASCADE
-- cleans up the share automatically when the page is deleted. The public
-- endpoint filters `revoked=0` when looking up by token.
CREATE TABLE IF NOT EXISTS page_shares (
  page_id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

-- O(1) lookup by token in the public endpoint (no auth required).
CREATE INDEX IF NOT EXISTS idx_page_shares_token ON page_shares(token);
