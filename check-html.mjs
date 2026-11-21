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

console.log(bad === 0 ? 'html check: balanced and properly nested' : `html check: ${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
