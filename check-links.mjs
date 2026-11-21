// check-links.mjs — every local href/src in the built pages must resolve to a
// file that actually exists in dist/, and every same-site "#anchor" must point
// at an id that page really declares. Catches a rename, a typo or a removed
// heading before shipping.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), 'dist');
let bad = 0, checked = 0, anchors = 0;

// id="…" on each built page, read once.
const ids = new Map();
for (const name of readdirSync(dist).filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(join(dist, name), 'utf8');
  ids.set(name, new Set([...html.matchAll(/\bid\s*=\s*"([^"]+)"/g)].map((m) => m[1])));
}

for (const name of readdirSync(dist).filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(join(dist, name), 'utf8');
  const refs = [...html.matchAll(/(?:href|src)\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (/^(https?:|mailto:|data:)/.test(ref)) continue;
    // A bare "#fragment" stays on this page.
    if (ref.startsWith('#')) {
      const id = ref.slice(1);
      if (!id) continue; // "#" alone is a top-of-page link
      anchors++;
      if (!ids.get(name).has(id)) {        console.log(`${name}: missing anchor -> ${ref}`);
        bad++;
      }
      continue;
    }
    checked++;
    const [target, frag] = ref.split('#');
    const file = target.split('?')[0];
    if (!existsSync(join(dist, file))) {
      console.log(`${name}: broken reference -> ${ref}`);
      bad++;
      continue;
    }
    // A cross-page anchor must exist in the page it names.
    if (frag && file.endsWith('.html') && ids.has(file)) {
      anchors++;
      if (!ids.get(file).has(frag)) {
        console.log(`${name}: missing anchor -> ${ref}`);
        bad++;
      }
    }
  }
}
console.log(bad === 0
  ? `link check: ${checked} local reference(s) and ${anchors} anchor(s), all resolve`
  : `link check: ${bad} broken`);
process.exit(bad === 0 ? 0 : 1);
