// SQL migration loader for independent PostgreSQL regression fixtures.
// Existing tests exercise the original 001-009 publication contract. Ranked
// session verification is tested separately against all migrations, including 010.
import { readFileSync,readdirSync } from 'node:fs';
const directory=new URL('../supabase/migrations/',import.meta.url);
export const MIGRATIONS=readdirSync(directory).filter(name=>/^\d{3}_.+\.sql$/.test(name)).sort();
/** Legacy regression fixtures stop before 010 by default; null means ALL migrations. */
export function migrations(before='010_ranked_sessions.sql') {
  return MIGRATIONS.filter(name=>before===null||name<before).map(name=>readFileSync(new URL(name,directory),'utf8')).join('\n');
}
