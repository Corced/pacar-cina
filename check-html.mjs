// check-html.mjs — structural checks for the built pages.
// 1. Block tags balance in count.
// 2. Tags nest properly (a stack walk), which catches a card header that was
//    deleted while its list survived — balanced by count, still broken.
// 3. Each page closes with </html>.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');

const VOID = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'source', 'area', 'col', 'embed', 'track', 'wbr']);
const BLOCK = new Set(['div', 'ul', 'li', 'p', 'table', 'tbody', 'thead', 'tr', 'td', 'th', 'span', 'b', 'h1', 'h2', 'pre', 'select', 'textarea', 'button', 'a', 'html', 'head', 'body', 'script']);

let bad = 0;

for (const name of readdirSync(dist).filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(join(dist, name), 'utf8');

  // strip comments so commented-out markup cannot unbalance the walk
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  let problems = 0;

  for (const m of clean.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g)) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const selfClose = m[3] === '/';
    if (!BLOCK.has(tag) || VOID.has(tag) || selfClose) continue;

    if (!closing) {
      stack.push(tag);
    } else {
      const top = stack.pop();
      if (top !== tag) {
        console.log(`${name}: </${tag}> closes <${top || 'nothing'}>`);
        problems++;
        if (problems > 4) break;
      }
    }
  }
  if (stack.length) { console.log(`${name}: unclosed <${stack.join('>, <')}>`); problems++; }

  if (!html.trimEnd().endsWith('</html>')) { console.log(`${name}: does not end with </html>`); problems++; }

  if (problems) bad += problems;
}

// The sign-in page is one key field and no role list. A page that lists the
// roles tells every visitor how many exist and what each may do; the key already
// names its role, so the hub resolves it (POST /session with {key} and no role).
// This is a source tripwire, and the disclosure came back once already as a
// capability table, which no functional test would notice.
const loginSrc = readFileSync(join(dist, 'login.html'), 'utf8');
for (const leak of ['data-role', 'id="roles"', 'partner', 'admin', 'superadmin', 'GLM_KEYS']) {
  if (loginSrc.includes(leak)) {
    console.log(`login.html: the sign-in page discloses "${leak}" - it is meant to name no roles`);
    bad++;
  }
}

// ── every id a script reads has to exist somewhere ──────────────────────────
// The defect that actually reached a browser was a script reading
// getElementById('personname') on a page with no such element: the key box
// opened, the name box was silently absent, and it read as "optional" rather
// than "broken". TypeScript would not have caught it - getElementById returns
// HTMLElement | null whether or not the id is in the document - so it is
// checked here, on the built output, where the markup and the script meet.
// ponytail: one pool of ids for every page, no page-to-script map; a script
// reading an id that exists only on some other page still passes. Tighten it
// only if that ever happens for real.
const knownIds = new Set();
for (const name of readdirSync(dist).filter((f) => f.endsWith('.html'))) {
  for (const m of readFileSync(join(dist, name), 'utf8').matchAll(/\bid="([^"]+)"/g)) knownIds.add(m[1]);
}
for (const name of readdirSync(dist).filter((f) => f.endsWith('.js'))) {
  const src = readFileSync(join(dist, name), 'utf8');
  // ids a script builds at run time (the captcha widget does this) are
  // legitimately absent from the static markup
  for (const m of src.matchAll(/\.id\s*=\s*'([^']+)'/g)) knownIds.add(m[1]);
  for (const m of src.matchAll(/setAttribute\(\s*'id'\s*,\s*'([^']+)'/g)) knownIds.add(m[1]);
  for (const m of src.matchAll(/id="([A-Za-z0-9_-]+)"/g)) knownIds.add(m[1]);

  const read = new Set();
  // chat.js/user.js read through typed helpers so the checker knows an input is
  // an HTMLInputElement; those helpers are id lookups too, so they are scanned
  // the same way or the two typed files would fall out of this guard.
  for (const m of src.matchAll(/(?:getElementById|\$|input|select|button)\(\s*'([A-Za-z0-9_-]+)'/g)) read.add(m[1]);
  const missing = [...read].filter((id) => !knownIds.has(id));
  if (missing.length) {
    console.log(`${name}: reads id(s) that no page defines: ${missing.join(', ')}`);
    bad += missing.length;
  }
}

console.log(bad === 0 ? 'html check: balanced and properly nested' : `html check: ${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
