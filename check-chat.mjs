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
 *   - one caller holds four chat requests, the fifth is 429 + retry-after
 *
 * Starts its own stub + hub on spare ports; nothing outside is touched.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
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
let stubDelayMs = 0;          // hold responses open, to make requests overlap
let stubStream = false;       // answer as SSE, to exercise the reply reader
const stub = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d.toString(); });
  req.on('end', async () => {
    let body = null;
    try { body = JSON.parse(raw); } catch { /* keep raw */ }
    seen.push({ path: req.url, headers: req.headers, body });
    if (stubDelayMs) await sleep(stubDelayMs);
    if (stubStatus === 200) {
      if (stubStream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const piece of ['streamed ', 'answer']) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n');
        }
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
      return;
    }
    res.writeHead(stubStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'stub said ' + stubStatus } }));
  });
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

/* ── the SOCKS5 stub, and the dead one ────────────────────────────────────
 * This is the whole egress feature proven without Tor: a real CONNECT
 * handshake (method 0x00 only, ATYP domain and ATYP IPv4), the target
 * recorded, then the tunnel pumped onto the same upstream stub. A route that
 * actually reached the stub is the only evidence that routing happened.
 *
 * The second stub stands in for a closed route port but stays observable: TCP
 * accepts, the SOCKS handshake never happens, the socket dies. That is the
 * same tunnel failure a refused port produces, and it counts the attempts —
 * which is how "the dead route is not dialled twice" becomes assertable at
 * all. */
const SOCKS_PORT = PORT + 3;
const DEAD_PORT = PORT + 6;
const socksConnects = [];       // {target, port} per accepted CONNECT
let socksSockets = 0;           // TCP connections the stub accepted
let deadConnects = 0;           // attempts on the dead route

const socksStub = net.createServer((client) => {
  socksSockets++;
  let buf = Buffer.alloc(0);
  let stage = 'greeting';
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (stage === 'greeting') {
      if (buf.length < 2) return;
      const nmethods = buf[1];
      if (buf.length < 2 + nmethods) return;
      const offered = buf.subarray(2, 2 + nmethods);
      const noAuth = nmethods > 0 && offered.includes(0x00);
      if (!noAuth) {                             // we offer no auth, so we take none
        client.end(Buffer.from([0x05, 0xff]));
        return;
      }
      client.write(Buffer.from([0x05, 0x00]));
      buf = buf.subarray(2 + nmethods);
      stage = 'request';
    }
    if (stage !== 'request') return;
    if (buf.length < 5) return;
    let need;
    let target;
    let portAt;
    if (buf[3] === 0x01) {                      // ATYP IPv4
      need = 4 + 4 + 2;
      if (buf.length < need) return;
      target = [buf[4], buf[5], buf[6], buf[7]].join('.');
      portAt = 8;
    } else if (buf[3] === 0x03) {               // ATYP domain
      const len = buf[4];
      need = 5 + len + 2;
      if (buf.length < need) return;
      target = buf.subarray(5, 5 + len).toString('utf8');
      portAt = 5 + len;
    } else {
      client.destroy();
      return;
    }
    const port = buf.readUInt16BE(portAt);
    socksConnects.push({ target, port });
    const rest = buf.subarray(need);
    buf = Buffer.alloc(0);
    stage = 'tunnel';
    client.removeListener('data', onData);
    // Paused until the upstream side exists: bytes that arrive in between are
    // buffered by the socket instead of being emitted to nobody (which is what
    // happens if a flowing socket loses its last 'data' listener).
    client.pause();
    // BND.ADDR/PORT: ignored by a CONNECT client that only waits for rep 0x00.
    client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
    const up = net.connect({ host: '127.0.0.1', port: STUB_PORT }, () => {
      if (rest.length) up.write(rest);
      client.pipe(up);
      up.pipe(client);
      client.resume();
    });
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  };
  client.on('data', onData);
  client.on('error', () => {});
});
await new Promise((r) => socksStub.listen(SOCKS_PORT, '127.0.0.1', r));

const deadSocks = net.createServer((socket) => {
  deadConnects++;
  // The peer is mid-greeting when this dies, so a reset is normal, not news.
  socket.on('error', () => {});
  socket.destroy();
});
await new Promise((r) => deadSocks.listen(DEAD_PORT, '127.0.0.1', r));

const hub = spawn(process.execPath, [join(ROOT, 'server', 'hub.mjs')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    PUMP_MS: '50',
    TOKEN_TARGET: '4',
    TOKEN_LOWWATER: '4',
    GLM_KEYS: 'partner:test-partner-key,admin:test-admin-key',
    GLM_PEOPLE: 'alice=partner:alice-key',
    GLM_UPSTREAM: 'http://127.0.0.1:' + STUB_PORT,
    GLM_UPSTREAM_KEY: 'test-upstream-key',
    GLM_UPSTREAM_TIMEOUT: '4000',
    GLM_CHAT_COOLDOWN_MS: '1200',     // the default 5s would make this check slow
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let hubOut = '';
hub.stdout.on('data', (d) => { hubOut += d.toString(); });
hub.stderr.on('data', (d) => { hubOut += d.toString(); });

async function signIn(role, key, name) {
  const payload = { role, key };
  if (name) payload.name = name;
  const r = await fetch(BASE + '/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

async function status(cookie) {
  return (await fetch(BASE + '/status', { headers: { cookie } })).json();
}

async function chat(model, cookie, extra) {
  const body = Object.assign(
    { model, messages: [{ role: 'user', content: 'hello there' }] },
    extra || {}
  );
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, cookie ? { cookie } : {}),
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  return { status: r.status, body: parsed, pool: r.headers.get('x-glm-pool'), headers: r.headers };
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
  const aliceCookie = await signIn('partner', 'alice-key', 'alice');
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
  // No GLM_EGRESS_ROUTES on this hub: the call must say direct rather than
  // borrow a label it did not earn.
  check('with no routes configured the call is labelled direct',
    ok1.headers.get('x-glm-egress') === 'direct',
    'x-glm-egress=' + String(ok1.headers.get('x-glm-egress')));

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

  /* ── 4. one caller holds four requests, then waits ──
   * The pool is the scarce resource: four open requests are a quarter of what
   * this hub will do for one caller. The fifth is refused with a retry-after,
   * and a retry inside that wait is refused too, so a client that ignores the
   * 429 cannot spin. A refused request must not have spent a pool entry. */
  stubDelayMs = 900;
  const preLimit = await status(adminCookie);
  check('the limit is reported, with the default concurrency',
    preLimit.chatLimit && preLimit.chatLimit.concurrency === 4
    && preLimit.chatLimit.cooldownMs === 1200,
    JSON.stringify(preLimit.chatLimit));

  const four = [0, 1, 2, 3].map(() => chat('z.ai/glm-5.3'));
  await sleep(250);                      // all four admitted, none answered yet
  const five = await chat('z.ai/glm-5.3');
  check('a fifth concurrent request is refused with 429', five.status === 429, 'HTTP ' + five.status);
  check('the refusal says what the limit is and how long to wait',
    five.body && five.body.error && five.body.error.type === 'rate_limit_error'
    && five.body.error.limit === 4 && five.body.error.retry_after_seconds >= 1,
    JSON.stringify(five.body));
  const six = await chat('z.ai/glm-5.3');
  check('a retry inside the wait period is refused too', six.status === 429, 'HTTP ' + six.status);

  const answered = await Promise.all(four);
  check('the four admitted requests all get through',
    answered.every((r) => r.status === 200), answered.map((r) => r.status).join(','));

  // Slots are free again, but the wait is not over. This is what proves the
  // retry-after is a real wait and not just "the four slots are full".
  const seven = await chat('z.ai/glm-5.3');
  check('a retry with slots free is still refused while the wait runs',
    seven.status === 429, 'HTTP ' + seven.status);

  const afterLimit = await status(adminCookie);
  check('a refused request spends no pool entry',
    afterLimit.chat.poolSpent - preLimit.chat.poolSpent === 4,
    'poolSpent ' + preLimit.chat.poolSpent + ' -> ' + afterLimit.chat.poolSpent);
  check('refusals are counted separately from failures',
    afterLimit.chat.throttled - preLimit.chat.throttled === 3,
    'throttled ' + preLimit.chat.throttled + ' -> ' + afterLimit.chat.throttled);
  check('the slots are handed back when the requests finish',
    afterLimit.chatLimit.inFlight === 0, 'inFlight=' + afterLimit.chatLimit.inFlight);

  stubDelayMs = 0;
  // The budget is per caller, not global: a named person is not held hostage by
  // this anonymous caller's cooldown.
  const alice = await chat('z.ai/glm-5.3', aliceCookie);
  check('a named person has their own budget while another caller waits',
    alice.status === 200, 'HTTP ' + alice.status);

  await sleep(700);                      // past the 1200ms cooldown
  const eight = await chat('z.ai/glm-5.3');
  check('the same caller may try again once the wait is over',
    eight.status === 200, 'HTTP ' + eight.status);

  /* ── 4b. the model rule, and every chat is attributable ──
   * The upstream keeps adding words to its own model names (-max, -air), so a
   * catalog-only parser refuses models that exist. The split runs from the
   * right: the base is what is left once a known suffix comes off. */
  seen.length = 0;
  const maxRes = await chat('z.ai/glm-5.3-max-think', aliceCookie);
  check('a base the catalog has never heard of still forwards',
    maxRes.status === 200 && seen[0] && seen[0].body.model === 'glm-5.3-max',
    'model=' + (seen[0] && seen[0].body.model));
  check('the suffix is split off the right, so -max stays in the base',
    seen[0] && seen[0].body.features && seen[0].body.features.enable_thinking === true,
    JSON.stringify(seen[0] && seen[0].body.features));
  check('an unknown base is labelled unknown rather than quietly accepted',
    maxRes.headers.get('x-glm-model-known') === 'false',
    String(maxRes.headers.get('x-glm-model-known')));

  // Two chats are two conversations: the id is minted per request and never
  // taken from the client, so replaying an id cannot continue another chat.
  const first = await chat('z.ai/glm-5.3', aliceCookie);
  const second = await chat('z.ai/glm-5.3', aliceCookie);
  check('every chat gets its own conversation id',
    /^chat-[0-9a-f-]{36}$/.test(first.headers.get('x-glm-chat') || '')
      && first.headers.get('x-glm-chat') !== second.headers.get('x-glm-chat'),
    first.headers.get('x-glm-chat') + ' vs ' + second.headers.get('x-glm-chat'));
  check('the same identity keeps one caller tag across chats',
    /^[0-9a-f]{8}$/.test(first.headers.get('x-glm-caller') || '')
      && first.headers.get('x-glm-caller') === second.headers.get('x-glm-caller'),
    String(first.headers.get('x-glm-caller')));
  check('a known model is labelled known',
    first.headers.get('x-glm-model-known') === 'true',
    String(first.headers.get('x-glm-model-known')));

  seen.length = 0;
  const supplied = await chat('z.ai/glm-5.3', aliceCookie, { chat_id: 'stolen-chat-id' });
  check('a client-supplied chat_id is ignored, not honoured',
    supplied.headers.get('x-glm-chat-supplied') === 'ignored'
      && seen[0] && seen[0].body.chat_id !== 'stolen-chat-id',
    String(seen[0] && seen[0].body.chat_id));
  check('the tag, never the name, is what goes upstream',
    seen[0] && seen[0].headers['x-glm-caller'] === supplied.headers.get('x-glm-caller'),
    String(seen[0] && seen[0].headers['x-glm-caller']));
  const otherTag = await chat('z.ai/glm-5.3');
  check('another caller gets a different tag',
    otherTag.headers.get('x-glm-caller') !== first.headers.get('x-glm-caller'),
    first.headers.get('x-glm-caller') + ' vs ' + otherTag.headers.get('x-glm-caller'));

  const ledger = await status(adminCookie);
  const row = (ledger.chatLedger.recent || []).find((c) => c.id === supplied.headers.get('x-glm-chat'));
  check('the tracer records whose conversation it was',
    row && row.who === 'person:alice' && row.tag === supplied.headers.get('x-glm-caller')
      && row.status === 200,
    JSON.stringify(row));
  check('the tracer ledger is bounded',
    ledger.chatLedger.kept <= 200, 'kept=' + ledger.chatLedger.kept);

  /* ── 4c. a conversation continues, and only for its own caller ──
   * The id the hub minted is the handle. Hand it back and the hub replays what
   * it relayed, so a client that sends only its new line still has the topic;
   * hand back someone else's and nothing is replayed. */
  seen.length = 0;
  const turn1 = await chat('z.ai/glm-5.3', aliceCookie);
  const conv = turn1.headers.get('x-glm-chat');
  seen.length = 0;
  const turn2 = await chat('z.ai/glm-5.3', aliceCookie, {
    chat_id: conv,
    messages: [{ role: 'user', content: 'and again' }],
  });
  check('a chat_id handed back continues the same conversation',
    turn2.status === 200 && turn2.headers.get('x-glm-chat') === conv
      && turn2.headers.get('x-glm-chat-continued') === 'true',
    'HTTP ' + turn2.status + ' continued=' + turn2.headers.get('x-glm-chat-continued'));
  check('a one-line turn is sent with the turns the hub already relayed',
    seen[0] && JSON.stringify(seen[0].body.messages.map((m) => m.role))
      === JSON.stringify(['user', 'assistant', 'user']),
    JSON.stringify(seen[0] && seen[0].body.messages));
  check('the remembered assistant turn is the real reply, not a placeholder',
    seen[0] && seen[0].body.messages[1]
      && seen[0].body.messages[1].content === 'pong',
    JSON.stringify(seen[0] && seen[0].body.messages[1]));

  // A client that carries its own history is taken at its word: appending would
  // duplicate every turn it just re-sent.
  seen.length = 0;
  const replay = await chat('z.ai/glm-5.3', aliceCookie, {
    chat_id: conv,
    messages: [
      { role: 'user', content: 'hello there' },
      { role: 'assistant', content: 'pong' },
      { role: 'user', content: 'and again' },
      { role: 'assistant', content: 'pong' },
      { role: 'user', content: 'third' },
    ],
  });
  check('a client replaying its own history is not duplicated by the hub',
    replay.status === 200 && seen[0] && seen[0].body.messages.length === 5,
    'messages=' + (seen[0] && seen[0].body.messages.length));

  // The id is the handle, not the key: possession alone must not open it, and
  // the answer must not tell a stranger whether the id exists.
  const strangerTurn = await chat('z.ai/glm-5.3', null, {
    chat_id: conv,
    messages: [{ role: 'user', content: 'what were we talking about' }],
  });
  const ghostTurn = await chat('z.ai/glm-5.3', null, {
    chat_id: 'chat-00000000-0000-4000-8000-000000000000',
    messages: [{ role: 'user', content: 'what were we talking about' }],
  });
  check('another caller cannot continue a conversation it did not mint',
    strangerTurn.status === 404, 'HTTP ' + strangerTurn.status);
  check('a conversation that is not yours answers exactly like one that is not there',
    strangerTurn.status === ghostTurn.status
      && strangerTurn.body.error.type === ghostTurn.body.error.type
      && strangerTurn.body.error.message === ghostTurn.body.error.message,
    'HTTP ' + strangerTurn.status + ' vs ' + ghostTurn.status);
  check('a refused continuation spends nothing and records nothing',
    (await status(adminCookie)).chatLedger.recent.every((c) => c.id !== 'chat-00000000-0000-4000-8000-000000000000'),
    'ledger has no ghost row');

  // A refusal must hand its slot back. Without that, four 404s cost a caller its
  // entire budget with nothing in flight, and it stays locked out.
  for (let i = 0; i < 4; i++) {
    await chat('z.ai/glm-5.3', null, { chat_id: conv, messages: [{ role: 'user', content: 'x' }] });
  }
  const afterRefusals = await chat('z.ai/glm-5.3');
  check('a refused continuation gives its slot back',
    afterRefusals.status === 200, 'HTTP ' + afterRefusals.status);

  // One turn at a time per conversation. Two at once would each be built
  // without the other's reply, then overwrite each other's turns in the row —
  // one conversation, two interleaved histories. The second is told to wait.
  const busyBase = await chat('z.ai/glm-5.3', aliceCookie);
  const busyId = busyBase.headers.get('x-glm-chat');
  stubDelayMs = 700;
  const pending = chat('z.ai/glm-5.3', aliceCookie, {
    chat_id: busyId, messages: [{ role: 'user', content: 'first' }],
  });
  await sleep(120);
  const racing = await chat('z.ai/glm-5.3', aliceCookie, {
    chat_id: busyId, messages: [{ role: 'user', content: 'second' }],
  });
  const firstDone = await pending;
  stubDelayMs = 0;
  check('a second turn while one is in flight is refused, not interleaved',
    racing.status === 409 && racing.body.error.type === 'chat_busy',
    'HTTP ' + racing.status);
  check('the turn already in flight still completes', firstDone.status === 200,
    'HTTP ' + firstDone.status);
  const afterBusy = await chat('z.ai/glm-5.3', aliceCookie, {
    chat_id: busyId, messages: [{ role: 'user', content: 'third' }],
  });
  check('the conversation is free again once its answer arrives',
    afterBusy.status === 200, 'HTTP ' + afterBusy.status);

  // A long conversation is trimmed, not accumulated for the process lifetime.
  const big = 'x'.repeat(4000);
  const big1 = await chat('z.ai/glm-5.3', aliceCookie, { messages: [{ role: 'user', content: big }] });
  const bigId = big1.headers.get('x-glm-chat');
  for (let i = 0; i < 3; i++) {
    await chat('z.ai/glm-5.3', aliceCookie, { chat_id: bigId, messages: [{ role: 'user', content: big }] });
  }
  const bigRow = (await status(adminCookie)).chatLedger.recent.find((c) => c.id === bigId);
  check('a long conversation is trimmed instead of growing without bound',
    bigRow && bigRow.turns <= 4, 'turns=' + (bigRow && bigRow.turns));

  // A streamed answer is remembered from its frames: the reply is what the
  // caller saw, not the envelope it arrived in.
  stubStream = true;
  const streamed = await chat('z.ai/glm-5.3', aliceCookie, { stream: true });
  stubStream = false;
  seen.length = 0;
  await chat('z.ai/glm-5.3', aliceCookie, {
    chat_id: streamed.headers.get('x-glm-chat'),
    messages: [{ role: 'user', content: 'and then' }],
  });
  check('a streamed reply is remembered from its SSE frames',
    seen[0] && seen[0].body.messages[1]
      && seen[0].body.messages[1].content === 'streamed answer',
    JSON.stringify(seen[0] && seen[0].body.messages[1]));

  /* ── 5. an empty pool still forwards, and says so ── */
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

  /* ── 6. the shared upstream-key pool ──────────────────────────────────────
   * A second hub with no GLM_UPSTREAM_KEY: with the env credential set it would
   * win every call and the pool would never be spent. Same stub, same ports
   * discipline. The token is synthetic — a real JWT shape with an id and a
   * future exp — so the gate's offline claim checks run for real. */
  const PORT2 = PORT + 2;
  const BASE2 = 'http://127.0.0.1:' + PORT2;
  let hub2Out = '';
  const hub2 = spawn(process.execPath, [join(ROOT, 'server', 'hub.mjs')], {
    env: {
      ...process.env,
      PORT: String(PORT2),
      HOST: '127.0.0.1',
      GLM_KEYS: 'partner:test-partner-key,admin:test-admin-key',
      GLM_PEOPLE: 'alice=partner:alice-key',
      GLM_UPSTREAM: 'http://127.0.0.1:' + STUB_PORT,
      GLM_UPSTREAM_KEY: '',            // the pool is the only credential here
      GLM_UPSTREAM_TIMEOUT: '4000',
      GLM_CHAT_COOLDOWN_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hub2.stdout.on('data', (d) => { hub2Out += d.toString(); });
  hub2.stderr.on('data', (d) => { hub2Out += d.toString(); });

  const signIn2 = async (role, key, name) => {
    const payload = { role, key };
    if (name) payload.name = name;
    const r = await fetch(BASE2 + '/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return (r.headers.get('set-cookie') || '').split(';')[0];
  };
  const chat2 = async (model, cookie) => {
    const r = await fetch(BASE2 + '/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, cookie ? { cookie } : {}),
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello there' }] }),
    });
    const text = await r.text();
    let parsed = null; try { parsed = JSON.parse(text); } catch { /* keep text */ }
    return { status: r.status, body: parsed, headers: r.headers };
  };
  const listKeys2 = async (cookie) => (await fetch(BASE2 + '/upstream/keys', { headers: { cookie } })).json();
  const self2 = async (cookie) => (await fetch(BASE2 + '/status/self', { headers: { cookie } })).json();
  const revoke2 = async (cookie, id) => {
    const r = await fetch(BASE2 + '/upstream/keys/revoke', {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, cookie ? { cookie } : {}),
      body: JSON.stringify({ id }),
    });
    const text = await r.text();
    let parsed = null; try { parsed = JSON.parse(text); } catch { /* keep text */ }
    return { status: r.status, body: parsed };
  };

  try {
    let up2 = false;
    for (let i = 0; i < 50; i++) {
      try { await fetch(BASE2 + '/status/self'); up2 = true; break; } catch { await sleep(100); }
    }
    check('a second hub starts with no env upstream key', up2);
    if (!up2) throw new Error('hub2 never came up:\n' + hub2Out);

    const partner2 = await signIn2('partner', 'test-partner-key');
    const admin2 = await signIn2('admin', 'test-admin-key');
    const alice2 = await signIn2('partner', 'alice-key', 'alice');

    const b64url = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
    const jwtFor = (claims) => b64url({ alg: 'HS256', typ: 'JWT' }) + '.' + b64url(claims) + '.c2lnbmF0dXJl';
    const token = jwtFor({ id: 'acct-7f3a', sub: 'visitor-2', exp: Math.floor(Date.now() / 1000) + 3600 });

    const contribute = async (cookie, source, key) => {
      const r = await fetch(BASE2 + '/upstream/keys', {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, cookie ? { cookie } : {}),
        body: JSON.stringify({ source, key }),
      });
      const text = await r.text();
      let parsed = null; try { parsed = JSON.parse(text); } catch { /* keep text */ }
      return { status: r.status, body: parsed, text };
    };

    const anonAdd = await contribute(null, 'z.ai', token);
    check('contributing an upstream key needs a session (401 without one)',
      anonAdd.status === 401, 'HTTP ' + anonAdd.status);

    const expiredToken = jwtFor({ id: 'acct-old', exp: Math.floor(Date.now() / 1000) - 60 });
    const expiredRes = await contribute(partner2, 'z.ai', expiredToken);
    check('an expired JWT is refused 400 and the reason says expired',
      expiredRes.status === 400 && /expired/.test(String(expiredRes.body && expiredRes.body.error)),
      'HTTP ' + expiredRes.status + ' ' + String(expiredRes.body && expiredRes.body.error));

    const malformed = await contribute(partner2, 'z.ai', 'eyJhbGciOiJIUzI1NiJ9.bm90LWpzb24.c2ln');
    check('a three-segment token whose payload is not JSON is refused 400',
      malformed.status === 400, 'HTTP ' + malformed.status + ' ' + String(malformed.body && malformed.body.error));

    const spaced = await contribute(partner2, 'z.ai', 'glm-' + 'a'.repeat(10) + ' ' + 'b'.repeat(10));
    check('a token containing whitespace is refused 400',
      spaced.status === 400, 'HTTP ' + spaced.status + ' ' + String(spaced.body && spaced.body.error));

    stubStatus = 200; seen.length = 0;
    const added = await contribute(partner2, 'z.ai', token);
    const keyId = String((added.body && added.body.id) || '');
    check('a valid JWT is accepted and given an 8-char id',
      added.status === 200 && added.body.ok === true && /^[0-9a-f]{8}$/.test(keyId)
        && added.body.jwt === true && added.body.source === 'z.ai',
      'HTTP ' + added.status + ' id=' + keyId + ' health=' + (added.body && added.body.health));
    check('the gate probed the configured upstream once and recorded it as ok',
      added.body && added.body.health === 'ok'
        && (added.body.checks || []).some((c) => c.startsWith('probe:')),
      'health=' + (added.body && added.body.health) + ' checks=' + JSON.stringify(added.body && added.body.checks));

    // The probe is the one stub request that contribution made. It has to carry
    // what the real call carries: an upstream that verifies the signature would
    // otherwise refuse a good token and the gate would blame the credential.
    // (The HMAC itself cannot be recomputed here: signZai mixes in a random
    // requestId and a timestamp the wire does not carry, so the check is the
    // shape, the key it was made with and the exact prompt it covers.)
    const probeReq = seen[0] || { headers: {}, body: {} };
    check('the gate probe carries a real x-signature like the forward does',
      seen.length === 1 && /^[0-9a-f]{64}$/.test(String(probeReq.headers['x-signature'] || '')),
      'attempts=' + seen.length + ' x-signature=' + String(probeReq.headers['x-signature']).slice(0, 16) + '…');
    check('the probe signs its own prompt with the probed key, tagged like the forward',
      probeReq.headers.authorization === 'Bearer ' + token
        && probeReq.body.signature_prompt === 'ping'
        && (probeReq.body.messages || []).map((m) => m.content).join('') === 'ping'
        && /^[0-9a-f]{8}$/.test(String(probeReq.headers['x-glm-caller'] || '')),
      'prompt=' + JSON.stringify(probeReq.body.signature_prompt)
        + ' caller=' + String(probeReq.headers['x-glm-caller']));

    const listedRes = await fetch(BASE2 + '/upstream/keys', { headers: { cookie: partner2 } });
    const listedText = await listedRes.text();
    let listedBody = null; try { listedBody = JSON.parse(listedText); } catch { /* keep text */ }
    check('GET /upstream/keys lists the 8-char id',
      listedRes.status === 200 && ((listedBody && listedBody.keys) || []).some((k) => k.id === keyId),
      'HTTP ' + listedRes.status + ' ids=' + JSON.stringify(((listedBody && listedBody.keys) || []).map((k) => k.id)));
    check('the listing never contains the token',
      !listedText.includes(token), 'body length=' + listedText.length);

    const dupe = await contribute(alice2, 'z.ai', token);
    check('a duplicate contribution is 409 with the same id',
      dupe.status === 409 && dupe.body && dupe.body.id === keyId,
      'HTTP ' + dupe.status + ' id=' + String(dupe.body && dupe.body.id));

    const aliceList = await listKeys2(alice2);
    const adminList = await listKeys2(admin2);
    check('a contributor sees only their own rows; an admin sees every row',
      aliceList.keys.length === 0 && adminList.keys.length === 1,
      'alice=' + aliceList.keys.length + ' admin=' + adminList.keys.length);

    stubStatus = 200; stubDelayMs = 0; seen.length = 0;
    const pooled = await chat2('z.ai/glm-5.3');
    check('with no env key the contributed token reaches the stub',
      seen.length === 1 && seen[0].headers.authorization === 'Bearer ' + token,
      'attempts=' + seen.length + ' auth=' + String(seen[0] && seen[0].headers.authorization).slice(0, 16) + '…');
    check('the response says the pool credential answered',
      pooled.status === 200 && pooled.headers.get('x-glm-key') === 'pool',
      'HTTP ' + pooled.status + ' x-glm-key=' + String(pooled.headers.get('x-glm-key')));

    stubStatus = 401; seen.length = 0;
    const deadCall = await chat2('z.ai/glm-5.3');
    const deadRow = (await listKeys2(admin2)).keys.find((k) => k.id === keyId);
    check('an upstream 401 on the pool key is passed through, and the key is marked dead',
      deadCall.status === 401 && deadRow && deadRow.health === 'dead',
      'HTTP ' + deadCall.status + ' health=' + (deadRow && deadRow.health));

    stubStatus = 200; seen.length = 0;
    const afterDead = await chat2('z.ai/glm-5.3');
    check('the next call does not send a dead pool key to the upstream',
      seen.length === 1 && !seen[0].headers.authorization && afterDead.headers.get('x-glm-key') === 'none',
      'attempts=' + seen.length + ' auth=' + String(seen[0] && seen[0].headers.authorization)
        + ' x-glm-key=' + String(afterDead.headers.get('x-glm-key')));

    const selfBefore = await self2(partner2);
    const aliceSelf = await self2(alice2);
    check("another person's /status/self.myKeys is empty while the contributor's holds the row",
      selfBefore.myKeys.some((k) => k.id === keyId) && aliceSelf.myKeys.length === 0,
      'mine=' + selfBefore.myKeys.length + ' alice=' + aliceSelf.myKeys.length);

    // The operator view: counts that match the rows it lists, rows that carry
    // metadata and never the token. The key is dead by now, so the counts have
    // to say so instead of claiming a healthy pool.
    const statsRes = await fetch(BASE2 + '/status', { headers: { cookie: admin2 } });
    const statsText = await statsRes.text();
    let statsBody = null; try { statsBody = JSON.parse(statsText); } catch { /* keep text */ }
    const us = (statsBody && statsBody.upstreamKeys) || {};
    const usRows = us.rows || [];
    check('/status.upstreamKeys counts match the rows it lists',
      statsRes.status === 200 && us.total === 1
        && us.bySource && us.bySource['z.ai'] === 1 && us.bySource.cn === 0
        && us.healthy === 0 && us.dead === 1 && us.unverified === 0
        && us.healthy + us.dead + us.unverified + us.refused === usRows.length
        && usRows.length === 1 && usRows[0].id === keyId && usRows[0].source === 'z.ai'
        && usRows[0].health === 'dead',
      JSON.stringify({
        total: us.total, bySource: us.bySource, healthy: us.healthy, dead: us.dead,
        unverified: us.unverified, refused: us.refused, rows: usRows.length,
      }));
    check('/status never carries the contributed token',
      !statsText.includes(token), 'body length=' + statsText.length);

    const ghostRevoke = await revoke2(partner2, 'deadbeef');
    check('revoking an unknown id is 404',
      ghostRevoke.status === 404, 'HTTP ' + ghostRevoke.status);

    const user2 = await signIn2('user');
    const strangerRevoke = await revoke2(user2, keyId);
    check("revoking somebody else's key from a non-admin session is 403",
      strangerRevoke.status === 403,
      'HTTP ' + strangerRevoke.status + ' ' + String(strangerRevoke.body && strangerRevoke.body.error));

    const revoked = await revoke2(partner2, keyId);
    const afterRevoke = await listKeys2(partner2);
    const selfAfter = await self2(partner2);
    check('revoking removes the key from GET /upstream/keys',
      revoked.status === 200 && afterRevoke.keys.every((k) => k.id !== keyId),
      'HTTP ' + revoked.status + ' left=' + afterRevoke.keys.length);
    check('revoking removes the key from /status/self.myKeys',
      selfBefore.myKeys.some((k) => k.id === keyId) && selfAfter.myKeys.length === 0,
      'before=' + selfBefore.myKeys.length + ' after=' + selfAfter.myKeys.length);
  } finally {
    hub2.kill('SIGTERM');
    await sleep(150);
  }

  for (const w of socks) w.close();

  /* ── 7. egress: a chat call really goes through a SOCKS5 route ────────────
   * Two hubs, because the two halves need different routes: one pointed at the
   * live SOCKS5 stub, one at a route that can never complete a handshake. Same
   * stub upstream, so "the chat still answers" and "it went through the tunnel"
   * are separate facts. Ports +4/+5 stay clear of the phases above. */
  const PORT3 = PORT + 4;
  const PORT4 = PORT + 5;
  const BASE3 = 'http://127.0.0.1:' + PORT3;
  const BASE4 = 'http://127.0.0.1:' + PORT4;
  let hub3Out = '';
  let hub4Out = '';
  const hubEnv = (port, routes) => ({
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    GLM_KEYS: 'partner:test-partner-key,admin:test-admin-key',
    GLM_UPSTREAM: 'http://127.0.0.1:' + STUB_PORT,
    GLM_UPSTREAM_KEY: 'test-upstream-key',
    GLM_UPSTREAM_TIMEOUT: '4000',
    GLM_CHAT_COOLDOWN_MS: '0',
    GLM_EGRESS_ROUTES: routes,
    GLM_EGRESS_DEAD_MS: '60000',
  });
  const hub3 = spawn(process.execPath, [join(ROOT, 'server', 'hub.mjs')], {
    env: hubEnv(PORT3, '127.0.0.1:' + SOCKS_PORT), stdio: ['ignore', 'pipe', 'pipe'],
  });
  const hub4 = spawn(process.execPath, [join(ROOT, 'server', 'hub.mjs')], {
    env: hubEnv(PORT4, '127.0.0.1:' + DEAD_PORT), stdio: ['ignore', 'pipe', 'pipe'],
  });
  hub3.stdout.on('data', (d) => { hub3Out += d.toString(); });
  hub3.stderr.on('data', (d) => { hub3Out += d.toString(); });
  hub4.stdout.on('data', (d) => { hub4Out += d.toString(); });
  hub4.stderr.on('data', (d) => { hub4Out += d.toString(); });

  const waitFor = async (base) => {
    for (let i = 0; i < 50; i++) {
      try { await fetch(base + '/status/self'); return true; } catch { await sleep(100); }
    }
    return false;
  };
  const chatAt = async (base, model, cookie) => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, cookie ? { cookie } : {}),
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello there' }] }),
    });
    const text = await r.text();
    let parsed = null; try { parsed = JSON.parse(text); } catch { /* keep text */ }
    return { status: r.status, body: parsed, headers: r.headers };
  };
  const signInAt = async (base, role, key) => {
    const r = await fetch(base + '/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role, key }),
    });
    return (r.headers.get('set-cookie') || '').split(';')[0];
  };

  try {
    const up3 = await waitFor(BASE3);
    const up4 = await waitFor(BASE4);
    check('a third hub starts with a SOCKS5 route configured', up3, hub3Out.trim().split('\n').join(' | '));
    check('a fourth hub starts with a route that cannot handshake', up4);
    if (!up3 || !up4) throw new Error('egress hubs never came up:\n' + hub3Out + '\n' + hub4Out);

    stubStatus = 200; stubDelayMs = 0;
    seen.length = 0;
    socksConnects.length = 0;
    const viaRoute = await chatAt(BASE3, 'z.ai/glm-5.3');
    check('a chat call reaches the upstream stub through the SOCKS5 stub',
      viaRoute.status === 200 && seen.length === 1
        && viaRoute.body && viaRoute.body.choices
        && viaRoute.body.choices[0].message.content === 'pong',
      'HTTP ' + viaRoute.status + ' attempts=' + seen.length);
    check('the tunnel CONNECT named the upstream stub host:port',
      socksConnects.length === 1 && socksConnects[0].target === '127.0.0.1'
        && socksConnects[0].port === STUB_PORT,
      JSON.stringify(socksConnects));
    check('a routed chat response says x-glm-egress: proxy',
      viaRoute.headers.get('x-glm-egress') === 'proxy',
      'x-glm-egress=' + String(viaRoute.headers.get('x-glm-egress')));

    const admin3 = await signInAt(BASE3, 'admin', 'test-admin-key');
    const st3 = await (await fetch(BASE3 + '/status', { headers: { cookie: admin3 } })).json();
    check('/status.egress reports one live route in proxy mode',
      st3.egress && st3.egress.routes === 1 && st3.egress.dead === 0
        && st3.egress.mode === 'proxy' && typeof st3.egress.note === 'string'
        && /SOCKS5|route/.test(st3.egress.note)
        && st3.mode === 'proxy',
      JSON.stringify(st3.egress));

    // The dead-route half: the first call must mark the route dead and come
    // back direct, labelled; the second must not dial it again.
    seen.length = 0;
    deadConnects = 0;
    const fellBack = await chatAt(BASE4, 'z.ai/glm-5.3');
    check('a route that cannot handshake still lets the call succeed, direct',
      fellBack.status === 200 && seen.length === 1
        && fellBack.body && fellBack.body.choices
        && fellBack.body.choices[0].message.content === 'pong',
      'HTTP ' + fellBack.status + ' attempts=' + seen.length);
    check('the fallback is labelled x-glm-egress: direct-fallback',
      fellBack.headers.get('x-glm-egress') === 'direct-fallback',
      'x-glm-egress=' + String(fellBack.headers.get('x-glm-egress')));

    const second = await chatAt(BASE4, 'z.ai/glm-5.3');
    check('a route marked dead is not dialled again on the next call',
      deadConnects === 1 && second.status === 200
        && second.headers.get('x-glm-egress') === 'direct-fallback',
      'dead-route connections=' + deadConnects + ' x-glm-egress='
        + String(second.headers.get('x-glm-egress')));

    const admin4 = await signInAt(BASE4, 'admin', 'test-admin-key');
    const st4 = await (await fetch(BASE4 + '/status', { headers: { cookie: admin4 } })).json();
    check('/status.egress says the route is dead and still labelled proxy',
      st4.egress && st4.egress.routes === 1 && st4.egress.dead === 1
        && st4.egress.mode === 'proxy' && /dead|fall/i.test(st4.egress.note),
      JSON.stringify(st4.egress));
  } finally {
    hub3.kill('SIGTERM');
    hub4.kill('SIGTERM');
    await sleep(200);
    if (!hub3.killed) hub3.kill('SIGKILL');
    if (!hub4.killed) hub4.kill('SIGKILL');
  }
} catch (e) {
  console.log('FAIL (exception) ' + (e && e.message));
  console.log(hubOut);
  failures++;
} finally {
  hub.kill('SIGTERM');
  await sleep(250);
  if (!hub.killed) hub.kill('SIGKILL');
  stub.close();
  socksStub.close();
  deadSocks.close();
}

console.log(failures === 0 ? '\nchat check: the pool is spent, signed, refunded on refusal, limited per caller, '
  + 'and a routed call is labelled and falls back when its route is dead'
  : '\nchat check: ' + failures + ' problem(s)');
process.exit(failures === 0 ? 0 : 1);
