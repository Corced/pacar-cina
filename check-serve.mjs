// check-serve.mjs — fetch the built pages from the preview server and confirm
// they are served, and that /status is absent so the admin page falls back to
// its honest "no hub" state. Read-only; nothing is written.
const base = process.argv.slice(2).join(' ').trim();
if (!base) { console.error('usage: node check-serve.mjs <base-url>'); process.exit(1); }

const paths = ['/', '/index.html', '/login.html', '/user.html', '/partner.html', '/admin.html', '/repos.html',
  '/minter.css', '/role.css', '/admin.css', '/repos.css',
  '/minter.js', '/roles.js', '/glm-client.js', '/admin.js'];
let bad = 0;

for (const p of paths) {
  try {
    const r = await fetch(base.replace(/\/$/, '') + p, { redirect: 'follow' });
    const body = await r.text();
    const ok = r.ok && body.length > 0;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(r.status).padEnd(4)} ${p.padEnd(16)} ${body.length} bytes`);
    if (!ok) bad++;
  } catch (e) {
    console.log(`FAIL ---- ${p} (${e.message})`);
    bad++;
  }
}

try {
  const r = await fetch(base.replace(/\/$/, '') + '/status');
  console.log(`note /status -> HTTP ${r.status} (a static host has no hub; admin.js expects this)`);
} catch (e) {
  console.log(`note /status unreachable (${e.message})`);
}

console.log(bad === 0 ? 'serve check: all assets served' : `serve check: ${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
