/* check-hub.mjs — start the hub and prove the contract the pages rely on.
 *
 * Identity is real now: the hub is started with known GLM_KEYS so the test can
 * sign in as partner and admin. It proves the gated pieces:
 *   - /status is refused without a session (401) and with the wrong role (403)
 *   - /minter/ws refuses a socket with no session
 *   - a partner session can mint, and the admin session can read the numbers
 *
 * Uses Node's built-in WebSocket client, so it needs no dependencies either.
 * Exits non-zero on the first failed expectation. Nothing outside this process
 * and the temp hub is touched; the hub holds everything in memory.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TEST_PORT || 5199);
const BASE = 'http://127.0.0.1:' + PORT;
const VERIFY_PORT = Number(process.env.TEST_VERIFY_PORT || 5202);

/* A stand-in for Aliyun's verify endpoint, so a donation's outbound exchange is
 * observable (and slow enough to overlap) without the network. It answers the
 * way Aliyun does for a param that is not valid: a JSON body with a code. */
let verifyCalls = 0;
let verifyDelayMs = 0;
const verifier = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d.toString(); });
  req.on('end', () => {
    verifyCalls++;
    const send = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 110, msg: 'not a valid answer' }));
    };
    if (verifyDelayMs) setTimeout(send, verifyDelayMs); else send();
  });
});
await new Promise((ok, bad) => {
  verifier.once('error', bad);
  verifier.listen(VERIFY_PORT, '127.0.0.1', ok);
});

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? '  — ' + extra : ''));
  if (!ok) failures++;
}

const hub = spawn(process.execPath, [join(ROOT, 'server', 'hub.mjs')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    PUMP_MS: '150',
    JOB_TIMEOUT_MS: '4000',
    GLM_KEYS: 'partner:test-partner-key,admin:test-admin-key',
    GLM_PEOPLE: 'alice=partner:alice-secret,bob=admin:bob-secret',
    GLM_CAPTCHA_VERIFY_URL: 'http://127.0.0.1:' + VERIFY_PORT + '/captcha/v3/verify',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let hubOut = '';
hub.stdout.on('data', (d) => { hubOut += d.toString(); });
hub.stderr.on('data', (d) => { hubOut += d.toString(); });

async function getJson(url, cookie) {
  const r = await fetch(BASE + url, { headers: cookie ? { cookie } : {} });
  const raw = await r.text();
  let body = null;
  try { body = JSON.parse(raw); } catch { /* non-json */ }
  return { status: r.status, ct: r.headers.get('content-type') || '', body, raw };
}

async function postJson(url, body, cookie) {
  const r = await fetch(BASE + url, {
    method: 'POST',
    headers: Object.assign(
      { 'content-type': 'application/json' },
      cookie ? { cookie } : {}
    ),
    body: JSON.stringify(body),
  });
  const raw = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* non-json */ }
  return { status: r.status, body: parsed, raw };
}

async function signIn(role, key, name) {
  const payload = { role };
  if (key) payload.key = key;
  if (name) payload.name = name;
  const r = await fetch(BASE + '/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await r.json();
  // getSetCookie() returns each Set-Cookie header separately (get() hides
  // HttpOnly ones), so the flags can be checked too.
  const setCookies = typeof r.headers.getSetCookie === 'function'
    ? r.headers.getSetCookie()
    : [r.headers.get('set-cookie') || ''];
  const raw = setCookies.find((c) => /glm_sid=/.test(c)) || '';
  const cookie = raw.split(';')[0];
  return { status: r.status, body, cookie, raw, name: body.name || null };
}

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/status/self'); up = true; break; } catch { await sleep(100); }
  }
  check('hub starts', up);
  if (!up) throw new Error('hub never came up:\n' + hubOut);

  // ── gated /status ──
  const noSession = await getJson('/status');
  check('/status refuses a caller with no session', noSession.status === 401, 'HTTP ' + noSession.status);

  // ── sign in ──
  const wrongKey = await signIn('admin', 'not-the-key');
  check('a wrong admin key is refused', wrongKey.status === 401, 'HTTP ' + wrongKey.status);

  const partner = await signIn('partner', 'test-partner-key');
  check('partner signs in with the key', partner.status === 200 && /glm_sid=/.test(partner.cookie));
  check('the session cookie is HttpOnly', /HttpOnly/i.test(partner.raw || ''), partner.raw);
  check('the session cookie is SameSite=Lax', /SameSite=Lax/i.test(partner.raw || ''));

  const admin = await signIn('admin', 'test-admin-key');
  check('admin signs in with the key', admin.status === 200 && /glm_sid=/.test(admin.cookie));

  const forbidden = await getJson('/status', partner.cookie);
  check('/status refuses a partner role (403)', forbidden.status === 403, 'HTTP ' + forbidden.status);

  const self = await getJson('/status/self', partner.cookie);
  check('/status/self is open to any signed-in role', self.status === 200 && self.body.role === 'partner');
  // The user page is built on this: what the hub can honestly say about the
  // caller's own contribution, and the pool's live numbers.
  check('/status/self says whether this address is an egress exit right now',
    self.body.you && typeof self.body.you.address === 'string'
      && self.body.you.offered === false && self.body.you.sockets === 0
      && self.body.you.mints === 0,
    JSON.stringify(self.body.you));
  check('/status/self reports the live pool, not a placeholder',
    self.body.poolNow && typeof self.body.poolNow.tokens === 'number'
      && typeof self.body.poolNow.online === 'number'
      && self.body.poolNow.target === self.body.pool.target,
    JSON.stringify(self.body.poolNow));

  // �� the two state-changing routes are gated ��
  /* Both of these were reachable with no session at all: /features changed the
   * defaults every chat request uses, and /admin/session/clear closed every
   * partner socket - one anonymous request could disconnect the whole fleet. */
  const featAnon = await postJson('/features', { web_search: true });
  check('/features refuses a caller with no session', featAnon.status === 401, 'HTTP ' + featAnon.status);
  const featPartner = await postJson('/features', { web_search: true }, partner.cookie);
  check('/features refuses a partner role (403)', featPartner.status === 403, 'HTTP ' + featPartner.status);
  const featAdmin = await postJson('/features', { web_search: true }, admin.cookie);
  check('/features accepts an admin and applies the value',
    featAdmin.status === 200 && featAdmin.body.features.web_search === true,
    'HTTP ' + featAdmin.status + ' ' + JSON.stringify(featAdmin.body.features));
  await postJson('/features', { web_search: false }, admin.cookie);   // leave it as found

  const clearAnon = await postJson('/admin/session/clear', {});
  check('/admin/session/clear refuses a caller with no session', clearAnon.status === 401,
    'HTTP ' + clearAnon.status);
  const clearPartner = await postJson('/admin/session/clear', {}, partner.cookie);
  check('/admin/session/clear refuses a partner role (403)', clearPartner.status === 403,
    'HTTP ' + clearPartner.status);

  // ── the socket requires a session ──
  let refused = false;
  try {
    const anon = new WebSocket('ws://127.0.0.1:' + PORT + '/minter/ws');
    await new Promise((res, rej) => {
      anon.onopen = () => res();
      anon.onerror = () => rej(new Error('refused'));
      setTimeout(() => rej(new Error('timed out')), 3000);
    });
  } catch { refused = true; }
  check('/minter/ws refuses a socket with no session', refused);

  // ── a partner session mints ──
  const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/minter/ws', {
    headers: { cookie: partner.cookie },
  });
  let mintsSent = 0;
  const ready = new Promise((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = (e) => rej(new Error('socket error ' + (e && e.message)));
    setTimeout(() => rej(new Error('socket never opened')), 5000);
  });
  await ready;
  check('a signed-in partner can open the mint socket', true);

  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
    if (m.type === 'job') {
      ws.send(JSON.stringify({ type: 'captcha', id: m.id, param: '{"captchaVerifyParam":"test"}' }));
      mintsSent++;
    }
  };
  ws.send(JSON.stringify({ type: 'hello', ip: '203.0.113.7', proto: 2 }));

  for (let i = 0; i < 40 && mintsSent === 0; i++) await sleep(150);
  check('partner receives a job with an id', mintsSent > 0, 'jobs received: ' + mintsSent);

  // The user page's whole point: the hub can say whether this caller's address
  // is an exit right now, and count what it returned. Matched on the address the
  // hub observed, not on the one the page claims in `hello`.
  const mineNow = await getJson('/status/self', partner.cookie);
  check('/status/self sees this caller\'s live socket and what it returned',
    mineNow.body.you.offered === true && mineNow.body.you.sockets >= 1
      && mineNow.body.you.mints >= 1 && typeof mineNow.body.you.since === 'number'
      && mineNow.body.poolNow.online >= 1,
    JSON.stringify({ you: mineNow.body.you, online: mineNow.body.poolNow && mineNow.body.poolNow.online }));

  // ── the admin session reads the gated numbers ──
  let s1;
  for (let i = 0; i < 40; i++) {
    s1 = await getJson('/status', admin.cookie);
    if (s1.body.minter && s1.body.minter.served >= 1) break;
    await sleep(150);
  }
  check('admin reads /status', s1.status === 200, 'HTTP ' + s1.status);
  check('a minted param was counted as served', s1.body.minter.served >= 1, 'served=' + s1.body.minter.served);
  check('the partner is listed online', s1.body.minter.online >= 1, 'online=' + s1.body.minter.online);
  check('the partner egress IP is recorded', s1.body.minter.egressIps >= 1);
  check('partners[] shows the role that opened the socket',
    s1.body.partners.some((p) => p.role === 'partner' && p.ip === '203.0.113.7'),
    JSON.stringify(s1.body.partners));
  check('pool available reflects recorded params', s1.body.pool.available >= 1);
  check('authMode says roles are keyed', /key/.test(s1.body.authMode || ''), s1.body.authMode);
  check('wsAuth says a session is required', /required|session/i.test(s1.body.wsAuth || ''), s1.body.wsAuth);

  // ── a graceful close must run the server's bookkeeping ──
  /* ws.close() is the ordinary path: a tab shutting, or the page sending a
   * close frame. conn.close() used to set the very flag the socket's own close
   * handler tested as its "already handled" guard, so onClose never fired. The
   * partner stayed online forever and a job in its hands waited out the timeout. */
  const onlineBefore = s1.body.minter.online;
  ws.close();
  let dropped = null;
  for (let i = 0; i < 40; i++) {
    const s = await getJson('/status', admin.cookie);
    if (s.body.minter.online === onlineBefore - 1) { dropped = s; break; }
    await sleep(50);
  }
  check('a graceful socket close takes the partner offline', !!dropped,
    'online was ' + onlineBefore + (dropped ? '' : ', and it never fell'));
  check('and marks that partner gone rather than leaving it idle',
    !!dropped && dropped.body.partners.some((p) => p.state === 'gone'),
    dropped ? JSON.stringify(dropped.body.partners.map((p) => p.state)) : 'no reading');

  // ── a partner that dies holding a job fails it at once ──
  const ws2 = new WebSocket('ws://127.0.0.1:' + PORT + '/minter/ws', {
    headers: { cookie: partner.cookie },
  });
  await new Promise((res, rej) => {
    ws2.onopen = () => res();
    ws2.onerror = (e) => rej(new Error('socket error ' + (e && e.message)));
    setTimeout(() => rej(new Error('socket never opened')), 5000);
  });
  // Deliberately never answers: the job is left in this partner's hands.
  ws2.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'ping') ws2.send(JSON.stringify({ type: 'pong' }));
  };
  ws2.send(JSON.stringify({ type: 'hello', ip: '203.0.113.8', proto: 2 }));

  let held = null;
  let lastInflight = -1;
  for (let i = 0; i < 40; i++) {
    const s = await getJson('/status', admin.cookie);
    lastInflight = s.body.minter.inflight;
    if (lastInflight >= 1) { held = s; break; }
    await sleep(50);
  }
  check('a silent partner is handed a job', !!held, 'inflight last read ' + lastInflight);
  const failedBefore = held ? held.body.minter.failed : 0;
  ws2.close();
  let freed = null;
  let freedInflight = -1;
  for (let i = 0; i < 30; i++) {            // 1.5 s, well under the 4 s job timeout
    const s = await getJson('/status', admin.cookie);
    freedInflight = s.body.minter.inflight;
    if (freedInflight === 0) { freed = s; break; }
    await sleep(50);
  }
  check('closing on a held job frees it at once, not after the timeout', !!freed,
    'JOB_TIMEOUT_MS is 4000, inflight is ' + freedInflight + ' after 1.5 s');
  check('and the abandoned job is counted as failed', !!freed && freed.body.minter.failed > failedBefore,
    freed ? failedBefore + ' -> ' + freed.body.minter.failed : 'no reading');

  // ── the honest refusal is unchanged ──
  const chat = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-4.7', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const cj = await chat.json();
  check('/v1/chat/completions still refuses honestly with 501',
    chat.status === 501 && /no upstream/.test(cj.error.message), 'HTTP ' + chat.status);

  // ── partner donations: the endpoint partner.html's form posts to ──
  const dn = await postJson('/tokens', { kind: 'token', value: 'donated-device-token-1' }, partner.cookie);
  check('a signed-in partner can donate a token', dn.status === 200 && dn.body.ok, JSON.stringify(dn.body));
  check('the donation answer keeps only a fingerprint',
    typeof dn.body.fp === 'string' && /^[0-9a-f]{16}$/.test(dn.body.fp) && dn.body.fp !== 'donated-device-token-1',
    dn.body.fp);
  const dn2 = await postJson('/tokens', { kind: 'token', value: 'donated-device-token-1' }, partner.cookie);
  check('the same value twice is a duplicate, not a second entry',
    dn2.status === 200 && dn2.body.duplicate === true && dn2.body.donated === 1, JSON.stringify(dn2.body));
  const dnNoSession = await postJson('/tokens', { kind: 'token', value: 'x' }, null);
  check('donating without a session is refused (401)', dnNoSession.status === 401, 'HTTP ' + dnNoSession.status);
  const dnBad = await postJson('/tokens', { kind: 'gadget', value: 'x' }, partner.cookie);
  check('a nonsense kind is refused (400)', dnBad.status === 400, 'HTTP ' + dnBad.status);
  const dnEmpty = await postJson('/tokens', { kind: 'token', value: '   ' }, partner.cookie);
  check('an empty value is refused (400)', dnEmpty.status === 400, 'HTTP ' + dnEmpty.status);
  const dnList = await getJson('/tokens', partner.cookie);
  check('GET /tokens counts kinds, never values',
    dnList.status === 200 && dnList.body.tokens === 1 && dnList.body.sessions === 0 && !/donated-device-token/.test(dnList.raw),
    JSON.stringify(dnList.body));
  const userCookie = await signIn('user', null);
  const dnUser = await postJson('/tokens', { kind: 'token', value: 'user-attempt' }, userCookie.cookie);
  check('the open user role cannot donate (403)', dnUser.status === 403, 'HTTP ' + dnUser.status);

  // ── model catalog: source/base[-suffix] ids ──
  const models = await getJson('/v1/models', null);
  const ids = (models.body && models.body.data ? models.body.data : []).map((m) => m.id);
  check('/v1/models lists the source-prefixed catalog',
    models.status === 200 && ids.length === 32 && ids.includes('z.ai/glm-5.3') && ids.includes('cn/glm-5.3'),
    ids.length + ' ids');
  const thinkEntry = (models.body.data || []).find((m) => m.id === 'z.ai/glm-5.3-think');
  check('a -think id carries its declared feature',
    !!thinkEntry && Array.isArray(thinkEntry.meta.features) && thinkEntry.meta.features.includes('thinking')
      && thinkEntry.meta.declared_only === true,
    JSON.stringify(thinkEntry && thinkEntry.meta));
  const unknownModel = await postJson('/v1/chat/completions',
    { model: 'gpt-9', messages: [{ role: 'user', content: 'hi' }] }, null);
  check('an unknown model is refused with the catalog hint (400)',
    unknownModel.status === 400 && /source/.test(unknownModel.body.error.message), 'HTTP ' + unknownModel.status);
  const bareAlias = await postJson('/v1/chat/completions',
    { model: 'glm-4.7', messages: [{ role: 'user', content: 'hi' }] }, null);
  check('a bare base name still resolves (alias) and 501s without upstream naming it',
    bareAlias.status === 501 && bareAlias.body.error.resolved_model === 'z.ai/glm-4.7',
    JSON.stringify(bareAlias.body.error && bareAlias.body.error.resolved_model));
  const suffixCall = await postJson('/v1/chat/completions',
    { model: 'cn/glm-5.3-deepresearch', messages: [{ role: 'user', content: 'hi' }] }, null);
  check('cn/ source ids resolve to the cn upstream path even without an upstream',
    suffixCall.status === 501 && suffixCall.body.error.resolved_model === 'cn/glm-5.3-deepresearch',
    JSON.stringify(suffixCall.body.error && suffixCall.body.error.resolved_model));

  // The upstream's own names grow (-max, -air), so resolution cannot be an
  // allow-list: a glm base outside the catalog resolves by rule and is marked
  // unknown instead of refused.
  const ruleModel = await postJson('/v1/chat/completions',
    { model: 'z.ai/glm-5.3-max-think', messages: [{ role: 'user', content: 'hi' }] }, null);
  check('a base outside the catalog resolves by rule, not by allow-list',
    ruleModel.status === 501
      && ruleModel.body.error.resolved_model === 'z.ai/glm-5.3-max-think'
      && ruleModel.body.error.model_known === false,
    JSON.stringify(ruleModel.body.error));
  const gpt = await postJson('/v1/chat/completions',
    { model: 'z.ai/gpt-9', messages: [{ role: 'user', content: 'hi' }] }, null);
  check('a non-glm base is still refused (400), even with a known source',
    gpt.status === 400, 'HTTP ' + gpt.status);

  // ── per-person identity: GLM_PEOPLE=alice=partner:alice-secret,bob=admin:bob-secret ──
  const alice = await signIn('partner', 'alice-secret', 'alice');
  check('a person signs in under their own name', alice.name === 'alice', JSON.stringify(alice.body));
  const badPerson = await signIn('partner', 'not-her-key', 'alice');
  check('a person with the wrong key is refused (401)', badPerson.status === 401, 'HTTP ' + badPerson.status);
  const whoAmI = await getJson('/session', alice.cookie);
  check('GET /session reports the person', whoAmI.body.name === 'alice' && whoAmI.body.role === 'partner',
    JSON.stringify(whoAmI.body));
  const peopleAsPartner = await getJson('/people', partner.cookie);
  check('the people directory is admin-only (partner 403)', peopleAsPartner.status === 403, 'HTTP ' + peopleAsPartner.status);
  const peopleAsAdmin = await getJson('/people', admin.cookie);
  check('the people directory lists alice and bob for admin',
    peopleAsAdmin.status === 200 && peopleAsAdmin.body.people.some((x) => x.name === 'alice' && x.role === 'partner')
      && peopleAsAdmin.body.people.some((x) => x.name === 'bob' && x.role === 'admin'),
    JSON.stringify(peopleAsAdmin.body.people && peopleAsAdmin.body.people.map((x) => x.name)));
  const dnAlice = await postJson('/tokens', { kind: 'session', value: 'alice-session-value-1' }, alice.cookie);
  check('a donation carries the person who sent it',
    dnAlice.status === 200,
    JSON.stringify(dnAlice.body));
  const allAsPartner = await getJson('/tokens?all=1', partner.cookie);
  check('the full donation list is admin-only (partner 403)', allAsPartner.status === 403, 'HTTP ' + allAsPartner.status);
  const allAsAdmin = await getJson('/tokens?all=1', admin.cookie);
  check('the full donation list names the person, never the value',
    allAsAdmin.status === 200
      && allAsAdmin.body.donations.some((x) => x.person === 'alice' && x.fp && x.status === 'unverified')
      && !/alice-session-value/.test(allAsAdmin.raw),
    JSON.stringify(allAsAdmin.body.donations && allAsAdmin.body.donations.map((x) => x.person)));
  const mineAlice = await getJson('/tokens?mine=1', alice.cookie);
  check('a partner sees their own donations with status',
    mineAlice.status === 200 && mineAlice.body.mine.length === 1 && mineAlice.body.mine[0].status === 'unverified',
    JSON.stringify(mineAlice.body.mine));

  // ── captcha verification: the real Aliyun exchange, admin-gated ──
  /* ── a flood of captcha-shaped donations is capped per caller ──
   * Each value below is long and base64-ish, so captchaParamFrom() accepts it
   * and each one becomes its own outbound Aliyun exchange. Four run at a time;
   * the fifth is refused before it is recorded or sent anywhere. */
  verifyDelayMs = 800;
  const ledgerBefore = await getJson('/tokens', admin.cookie);
  const flood = await Promise.all(['a', 'b', 'c', 'd', 'e'].map(
    (c) => postJson('/tokens', { kind: 'session', value: c.repeat(60) }, partner.cookie)));
  check('four captcha-shaped donations from one caller are accepted at once',
    flood.filter((r) => r.status === 200).length === 4,
    flood.map((r) => r.status).join(','));
  const floodRefused = flood.find((r) => r.status === 429);
  check('the fifth is refused with 429', Boolean(floodRefused), flood.map((r) => r.status).join(','));
  check('the refusal names the limit and the wait',
    floodRefused && floodRefused.body && floodRefused.body.error.type === 'rate_limit_error'
      && floodRefused.body.error.limit === 4 && floodRefused.body.error.retry_after_seconds === 2,
    JSON.stringify(floodRefused && floodRefused.body));
  // Wait for the four accepted exchanges to reach the stub instead of assuming
  // 200 ms is enough on a loaded machine — that assumption failed once in a
  // full `npm run check` while passing alone. Then give a late fifth one room
  // to arrive, so the assertion is about the cap, not about timing.
  for (let i = 0; i < 60 && verifyCalls < 4; i++) await sleep(50);
  await sleep(150);
  check('a refused donation never reaches Aliyun', verifyCalls === 4, 'calls=' + verifyCalls);
  const ledgerAfter = await getJson('/tokens', admin.cookie);
  check('a refused donation is not recorded in the ledger',
    ledgerAfter.body.held === ledgerBefore.body.held + 4,
    'held ' + ledgerBefore.body.held + ' -> ' + ledgerAfter.body.held);
  await sleep(900);                      // the stub answers after 800ms
  const afterFlood = await getJson('/status', admin.cookie);
  check('the verifying count is back to zero once the exchanges settle',
    afterFlood.body.donationLimit.verifying === 0
      && afterFlood.body.donationLimit.throttled === 1,
    JSON.stringify(afterFlood.body.donationLimit));
  verifyDelayMs = 0;

  const cvPartner = await postJson('/captcha/verify', { param: 'x' }, partner.cookie);
  check('captcha verification is admin-only (partner 403)', cvPartner.status === 403, 'HTTP ' + cvPartner.status);
  const cvNone = await postJson('/captcha/verify', { param: 'x' }, null);
  check('captcha verification needs a session (401)', cvNone.status === 401, 'HTTP ' + cvNone.status);
  const cvBad = await postJson('/captcha/verify', { fp: '0'.repeat(16) }, admin.cookie);
  check('verifying an unknown fingerprint is 404', cvBad.status === 404, 'HTTP ' + cvBad.status);
  const cvMissing = await postJson('/captcha/verify', { fp: dnAlice.body.fp }, admin.cookie);
  check('a donated value can only be exchanged when re-supplied (400)',
    cvMissing.status === 400 && /fingerprint/.test(cvMissing.body.error), JSON.stringify(cvMissing.body));
  const cvRun = await postJson('/captcha/verify',
    { fp: allAsAdmin.body.donations.find((x) => x.person === 'alice').fp, value: 'alice-session-value-1' },
    admin.cookie);
  check('a verification run answers with an honest status (unverified without network)',
    cvRun.status === 200 && cvRun.body.ok === true
      && ['valid', 'invalid', 'unverified'].includes(cvRun.body.status),
    cvRun.body.status + ' — ' + (cvRun.body.detail || ''));
  const afterCv = await getJson('/status', admin.cookie);
  // The pool counters are named donatedValid / donatedInvalid / …, so the
  // status the exchange settled on has to be mapped, not passed through: a
  // bare `pool[status]` reads `pool.invalid`, which does not exist.
  const poolKey = 'donated' + cvRun.body.status[0].toUpperCase() + cvRun.body.status.slice(1);
  check('the captcha counters and the donation status moved together',
    afterCv.body.captcha.checked >= 1
      && (cvRun.body.status === 'unverified'
        ? afterCv.body.pool.donatedValid === 0
        : afterCv.body.pool[poolKey] >= 1)
      && afterCv.body.people.count === 3, // alice, bob, and the seeded superadmin
    'checked=' + afterCv.body.captcha.checked + ' people=' + afterCv.body.people.count
      + ' ' + poolKey + '=' + afterCv.body.pool[poolKey]);

  // ── the donation ledger has a ceiling ──
  /* /tokens?all=1 serialises every donation, so the array carries the same
   * 200-entry cap as state.captchaChecks. These values are not captcha-shaped,
   * so each settles without a network call. Runs last: the assertions above
   * count the two donations this test makes. */
  for (let i = 0; i < 205; i++) {
    await postJson('/tokens', { kind: 'token', value: 'ledger-probe-' + i }, partner.cookie);
  }
  const ledger = await getJson('/tokens', admin.cookie);
  check('the donation ledger is capped instead of growing for the process lifetime',
    ledger.status === 200 && ledger.body.held === 200, 'held=' + (ledger.body && ledger.body.held));

  ws.close();
} catch (e) {
  console.log('FAIL (exception) ' + (e && e.message));
  failures++;
} finally {
  console.log(failures === 0
    ? 'hub check: routes, auth, sockets and donations all hold'
    : 'hub check: ' + failures + ' failure(s)');
  hub.kill('SIGTERM');
  verifier.close();
  setTimeout(() => process.exit(failures > 0 ? 1 : 0), 300);
}
