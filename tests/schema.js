// Applies every ordered SQL migration exactly as an operator would on a fresh installation.
import { readFileSync,readdirSync } from 'node:fs';
const directory=new URL('../supabase/migrations/',import.meta.url);
export const MIGRATIONS=readdirSync(directory).filter(name=>/^\d{3}_.+\.sql$/.test(name)).sort();
/** Concatenated SQL text of the ordered migrations, optionally stopping before a given file. */
export function migrations(before=null) {
  return MIGRATIONS.filter(name=>before===null||name<before).map(name=>readFileSync(new URL(name,directory),'utf8')).join('\n');
}
