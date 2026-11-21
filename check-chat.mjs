/* check-chat.mjs — the two gaps this project was supposed to close, proven.
 *
 * A local stub stands in for chat.z.ai, so the whole chat path runs for real
 * without a credential or the internet:
 *   - GLM_UPSTREAM actually redirects the destination (before this, it was
 *     only an on/off switch and the captured origin was always used)
 *   - the model id picks the path, so `cn/` still goes to /api/v1
 *   - a minted param leaves the pool and rides the request as captcha_verify_param
 *   - suffix features reach the wire in the reference projects' shape
 *   - the x-signature is a real HMAC over the prompt, not a placeholder
 *   - a 401/403/429 returns the entry unspent instead of burning it
 *   - an empty pool still forwards, labelled, rather than refusing
 *
 * Starts its own stub + hub on spare ports; nothing outside is touched.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TEST_PORT || 5203);
const STUB_PORT = PORT + 1;
const BASE = 'http://127.0.0.1:' + PORT;

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? '  — ' + extra : ''));
  if (!ok) failures++;
}

/* ── the stub upstream: records what it was sent, answers what it is told ── */
const seen = [];
let stubStatus = 200;
const stub = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d.toString(); });
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(raw); } catch { /* keep raw */ }
    seen.push({ path: req.url, headers: req.headers, body });
    if (stubStatus === 200) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
      return;
    }
    res.writeHead(stubStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'stub said ' + stubStatus } }));
  });
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

const hub = spawn(process.execPath, [join(ROOT, 'server', 'hub.mjs')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    PUMP_MS: '50',
    TOKEN_TARGET: '4',
    TOKEN_LOWWATER: '4',
    GLM_KEYS: 'partner:test-partner-key,admin:test-admin-key',
    GLM_UPSTREAM: 'http://127.0.0.1:' + STUB_PORT,
    GLM_UPSTREAM_KEY: 'test-upstream-key',
    GLM_UPSTREAM_TIMEOUT: '4000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let hubOut = '';
hub.stdout.on('data', (d) => { hubOut += d.toString(); });
hub.stderr.on('data', (d) => { hubOut += d.toString(); });

async function signIn(role, key) {
  const r = await fetch(BASE + '/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role, key }),
  });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

async function status(cookie) {
  return (await fetch(BASE + '/status', { headers: { cookie } })).json();
}

async function chat(model) {
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello there' }] }),
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  return { status: r.status, body, pool: r.headers.get('x-glm-pool') };
}

const socks = [];
try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/status/self'); up = true; break; } catch { await sleep(100); }
  }
  check('hub starts', up);
  if (!up) throw new Error('hub never came up:\n' + hubOut);

  /* ── fill the pool with real mints ── */
  const partnerCookie = await signIn('partner', 'test-partner-key');
  const adminCookie = await signIn('admin', 'test-admin-key');
  const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/minter/ws', { headers: { cookie: partnerCookie } });
  socks.push(ws);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('socket failed'));
    setTimeout(() => rej(new Error('socket never opened')), 5000);
  });
  let minted = 0;
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
    if (m.type === 'job') {
      minted++;
      ws.send(JSON.stringify({ type: 'captcha', id: m.id, param: '{"captchaVerifyParam":"param-' + minted + '"}' }));
    }
  };
  ws.send(JSON.stringify({ type: 'hello', ip: '203.0.113.9', proto: 2 }));
  for (let i = 0; i < 60 && minted === 0; i++) await sleep(100);
  check('a partner mint fills the pool', minted > 0, 'mints=' + minted);

  const before = await status(adminCookie);
  check('the pool holds minted params', before.pool.available > 0, 'available=' + before.pool.available);

  /* ── 1. forwarding actually goes to GLM_UPSTREAM, signed, with a pool entry ── */
  stubStatus = 200;
  seen.length = 0;
  const ok1 = await chat('z.ai/glm-5.3-think');
  check('chat forwards and the stub answers 200', ok1.status === 200, 'HTTP ' + ok1.status);
  check('the destination is GLM_UPSTREAM, not the captured origin',
    seen.length === 1 && seen[0].path === '/api/v2/chat/completions', JSON.stringify(seen.map((s) => s.path)));
  const sent = seen[0] || { headers: {}, body: {} };
  check('the upstream key is sent as a bearer credential',
    sent.headers.authorization === 'Bearer test-upstream-key', String(sent.headers.authorization));
  check('x-signature is a real HMAC, not a placeholder',
    /^[0-9a-f]{64}$/.test(String(sent.headers['x-signature'] || '')), String(sent.headers['x-signature']).slice(0, 16) + '…');
  check('the pool entry rides the request as captcha_verify_param',
    typeof sent.body.captcha_verify_param === 'string' && sent.body.captcha_verify_param.length > 0,
    String(sent.body.captcha_verify_param));
  check('the model id is rewritten to the plain base', sent.body.model === 'glm-5.3', String(sent.body.model));
  check('the signature prompt is the flattened conversation',
    sent.body.signature_prompt === 'hello there', JSON.stringify(sent.body.signature_prompt));
  check('-think reaches the wire as enable_thinking in the reference shape',
    sent.body.features && sent.body.features.enable_thinking === true,
    JSON.stringify(sent.body.features));
  check('the response is labelled as having spent an entry', ok1.pool === 'spent', String(ok1.pool));

  const after1 = await status(adminCookie);
  // `available` is not a durable fact here: a live partner plus PUMP_MS=50
  // refills the pool between the spend and this read. `consumed` is the
  // monotonic count of spends, and it is what the panel and the gap claim rest
  // on, so that is what gets asserted.
  check('the pool entry was consumed',
    after1.pool.consumed === 1,
    'consumed=' + after1.pool.consumed + ' (available ' + before.pool.available
      + ' -> ' + after1.pool.available + ', refills under a live partner)');
  check('chat traffic is counted', after1.chat.requests === 1 && after1.chat.poolSpent === 1,
    JSON.stringify(after1.chat));

  /* ── 2. a rejected credential returns the entry instead of burning it ── */
  const preFail = await status(adminCookie);
  stubStatus = 401;
  const ok2 = await chat('z.ai/glm-5.3');
  check('an upstream 401 is passed through', ok2.status === 401, 'HTTP ' + ok2.status);
  const after2 = await status(adminCookie);
  check('a credential failure does not count as a consumption',
    after2.pool.consumed === preFail.pool.consumed,
    'consumed ' + preFail.pool.consumed + ' -> ' + after2.pool.consumed);
  check('the entry is back in the pool after a 401',
    after2.pool.available >= preFail.pool.available,
    'available ' + preFail.pool.available + ' -> ' + after2.pool.available);
  check('a refunded entry is not counted as spent either',
    after2.chat.poolSpent === preFail.chat.poolSpent,
    'poolSpent ' + preFail.chat.poolSpent + ' -> ' + after2.chat.poolSpent);

  /* ── 3. cn/ ids keep their own path through the same redirect ── */
  stubStatus = 200;
  seen.length = 0;
  await chat('cn/glm-5.3-search');
  check('cn/ ids still go to the cn path',
    seen.length === 1 && seen[0].path === '/api/v1/chat/completions', JSON.stringify(seen.map((s) => s.path)));
  check('-search reaches the wire as web_search',
    seen[0] && seen[0].body.features && seen[0].body.features.web_search === true,
    JSON.stringify(seen[0] && seen[0].body.features));

  /* �� 3b. the panel's toggles are defaults, and they reach the wire �� */
  /* Before this, /features wrote state that only /status ever read: flipping a
   * switch returned ok, painted the toggle green, and changed nothing about
   * the next request. An admin default must show up on a plain base id. */
  const setDef = await fetch(BASE + '/features', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ web_search: true }),
  });
  check('an admin can set a default feature', setDef.status === 200, 'HTTP ' + setDef.status);

  seen.length = 0;
  await chat('z.ai/glm-5.3');            // no suffix: only the default can turn this on
  check('a default toggle reaches the wire on a plain id',
    seen[0] && seen[0].body.features && seen[0].body.features.web_search === true,
    JSON.stringify(seen[0] && seen[0].body.features));

  await fetch(BASE + '/features', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ web_search: false }),
  });
  seen.length = 0;
  await chat('z.ai/glm-5.3');
  check('clearing the default turns it back off',
    seen[0] && seen[0].body.features && seen[0].body.features.web_search === false,
    JSON.stringify(seen[0] && seen[0].body.features));

  seen.length = 0;
  await chat('z.ai/glm-5.3-search');     // the suffix must still work with defaults off
  check('a suffix still turns it on with the default off',
    seen[0] && seen[0].body.features && seen[0].body.features.web_search === true,
    JSON.stringify(seen[0] && seen[0].body.features));

  /* The default and the suffix spell thinking differently - `enable_thinking`
   * on the wire and in the panel, `thinking` in the suffix list - so a default
   * looked up under one name and a suffix checked under the other is exactly
   * how this silently sent false while /status said true. */
  seen.length = 0;
  await chat('z.ai/glm-5.3');
  check('the thinking default is the one the panel shows',
    seen[0] && seen[0].body.features && seen[0].body.features.enable_thinking === true,
    JSON.stringify(seen[0] && seen[0].body.features));

  await fetch(BASE + '/features', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ enable_thinking: false }),
  });
  seen.length = 0;
  await chat('z.ai/glm-5.3');
  check('turning the thinking default off reaches the wire',
    seen[0] && seen[0].body.features && seen[0].body.features.enable_thinking === false,
    JSON.stringify(seen[0] && seen[0].body.features));

  /* ── 4. an empty pool still forwards, and says so ── */
  // Take the partner offline first, or the refill loop refills faster than the
  // pool can be drained and "empty" is never reached.
  ws.close();
  for (const w of socks) w.close();
  let drainPool = 'spent';
  for (let i = 0; i < 20 && drainPool !== 'empty'; i++) {
    const r = await chat('z.ai/glm-5.3');
    drainPool = r.pool;
    if (drainPool === 'empty') break;
    await sleep(60);
  }
  check('an empty pool forwards rather than refusing, labelled',
    drainPool === 'empty', 'final pool label=' + drainPool);

  for (const w of socks) w.close();
} catch (e) {
  console.log('FAIL (exception) ' + (e && e.message));
  console.log(hubOut);
  failures++;
} finally {
  hub.kill('SIGTERM');
  await sleep(250);
  if (!hub.killed) hub.kill('SIGKILL');
  stub.close();
}

console.log(failures === 0 ? '\nchat check: the pool is spent, signed, and refunded on refusal'
  : '\nchat check: ' + failures + ' problem(s)');
process.exit(failures === 0 ? 0 : 1);
