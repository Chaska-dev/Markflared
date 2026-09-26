-- Workspace singleton: the user's workspace name and icon shown in the
-- sidebar. A single row (id=1) initialized with sensible defaults. Lets the
-- user edit branding from a popover without creating a "special page".

CREATE TABLE IF NOT EXISTS workspace (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'My Workspace',
  icon TEXT NOT NULL DEFAULT '📋',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO workspace (id, name, icon) VALUES (1, 'My Workspace', '📋');
