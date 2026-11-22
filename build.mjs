// Build: copy everything in public/ into dist/ verbatim.
// No bundler needed — the site is plain HTML/CSS/JS, like the original.
// Research material (app/.repos, fetch-repos.mjs) lives outside public/,
// so it never reaches the published site.
import { cpSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'public');
const out = join(root, 'dist');

rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const files = walk(out);
for (const f of files) {
  console.log(`dist/${relative(out, f).replaceAll('\\', '/')} (${statSync(f).size} bytes)`);
}

// Guard: the published site must stay self-contained static files.
const required = ['index.html', 'login.html', 'user.html', 'partner.html', 'admin.html', 'chat.html', 'repos.html'];
for (const r of required) {
  if (!files.some((f) => relative(out, f).replaceAll('\\', '/') === r)) {
    throw new Error(`build output is missing ${r}`);
  }
}

// Guard: server code must never end up in the published site. dist/ is served
// by the hub, so a stray .mjs here would be downloadable source.
const leaked = files.filter((f) => /\.(mjs|cjs)$/.test(f) || /[\\/]server[\\/]/.test(relative(out, f)));
if (leaked.length) {
  throw new Error('server code leaked into dist/: ' + leaked.map((f) => relative(out, f)).join(', '));
}

console.log(`build ok: ${files.length} file(s) -> dist/`);
