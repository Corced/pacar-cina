// check-doc-links.mjs — local markdown links must point to files that exist.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.repos' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(path);
  }
}
walk(root);

let bad = 0;
let checked = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
    const href = m[1];
    if (/^(?:https?:|mailto:|data:|#)/.test(href)) continue;
    const target = resolve(dirname(file), decodeURIComponent(href.split('#')[0]));
    checked++;
    if (!existsSync(target) || !statSync(target).isFile()) {
      console.log('FAIL ' + relative(root, file) + ' -> ' + href);
      bad++;
    }
  }
}
console.log(bad === 0
  ? `doc link check: ${checked} local markdown link(s), all resolve`
  : `doc link check: ${bad} broken`);
process.exit(bad === 0 ? 0 : 1);
