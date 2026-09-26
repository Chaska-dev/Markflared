// CLI to run migrations without booting the server. Useful when you want to
// reset the DB or apply new migrations manually.
import { runMigrations } from './db';
const { applied, skipped } = runMigrations();
if (applied.length === 0 && skipped.length === 0) {
  console.log('[migrate] nothing to apply');
} else {
  console.log(`[migrate] applied: ${applied.join(', ') || '(none)'}`);
  console.log(`[migrate] already in DB: ${skipped.join(', ') || '(none)'}`);
}
