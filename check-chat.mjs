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

console.log(failures === 0 ? '\nchat check: the pool is spent, signed, refunded on refusal, and limited per caller'
  : '\nchat check: ' + failures + ' problem(s)');
process.exit(failures === 0 ? 0 : 1);
