/* check-people.mjs — the directory is mutable at runtime, and revocation is
 * real: the key stops working on the NEXT request, and the person's live
 * sessions and mint sockets are dropped with it, with no restart.
 *
 * Before this, removing a person meant editing GLM_PEOPLE and restarting the
 * hub — which also emptied the pool. That is the gap this proves closed.
 *
 * Covers:
 *   - superadmin creates a person; the key is returned once and never listed
 *   - a created person can sign in under their own name
 *   - revocation kills the key (401), the live cookie (401) and the socket
 *   - rotation issues a new key, kills sessions, and the old key stops working
 *   - an env-pinned person cannot be revoked or rotated from the API
 *   - a partner cannot create people; an admin cannot revoke a superadmin
 *   - with GLM_STATE_FILE set the directory survives a restart, and revocation
 *     survives it too: a revoked key is still refused after the hub restarts
 */
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TEST_PORT || 5205);
const BASE = 'http://127.0.0.1:' + PORT;
const STATE_FILE = join(tmpdir(), 'glm-people-check-' + process.pid + '.json');
const SEED_FILE = join(tmpdir(), 'glm-seed-check-' + process.pid + '.json');

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? '  — ' + extra : ''));
  if (!ok) failures++;
}

try { rmSync(STATE_FILE, { force: true }); } catch { /* fine */ }

let hub = null;
let hubOut = '';
function startHub(over = {}) {
  hubOut = '';
  const child = spawn(process.execPath, [join(ROOT, 'server', 'hub.mjs')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      PUMP_MS: '60',
      GLM_KEYS: 'partner:test-partner-key,admin:test-admin-key',
      GLM_PEOPLE: 'pinned=partner:pinned-secret',
      GLM_SUPERADMIN: 'test-super-key',
      GLM_STATE_FILE: STATE_FILE,
      ...over,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { hubOut += d.toString(); });
  child.stderr.on('data', (d) => { hubOut += d.toString(); });
  return child;
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/status/self'); return true; } catch { await sleep(100); }
  }
  return false;
}

async function stopHub(child) {
  child.kill('SIGTERM');
  await sleep(300);
  if (!child.killed) child.kill('SIGKILL');
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
  const body = await r.json().catch(() => null);
  return {
    status: r.status,
    body,
    cookie: (r.headers.get('set-cookie') || '').split(';')[0],
  };
}

async function api(method, path, body, cookie) {
  const r = await fetch(BASE + path, {
    method,
    headers: Object.assign(
      { 'content-type': 'application/json' },
      cookie ? { cookie } : {}
    ),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  return { status: r.status, body: parsed, raw: text };
}

try {
  hub = startHub();
  check('hub starts with a state file', await waitUp());
  if (!hubOut && failures) throw new Error('hub never came up');

  const superR = await signIn('superadmin', 'test-super-key');
  check('the seeded superadmin signs in with the pinned key',
    superR.status === 200 && /glm_sid=/.test(superR.cookie), 'HTTP ' + superR.status);
  const adminR = await signIn('admin', 'test-admin-key');
  const partnerR = await signIn('partner', 'test-partner-key');

  /* ── create ── */
  const madeCarol = await api('POST', '/people', { name: 'carol', role: 'partner' }, superR.cookie);
  check('a superadmin creates a person and gets the key exactly once',
    madeCarol.status === 201 && typeof madeCarol.body.key === 'string' && madeCarol.body.key.length > 10,
    'HTTP ' + madeCarol.status);
  const carolKey = madeCarol.body.key;

  const list1 = await api('GET', '/people', undefined, adminR.cookie);
  check('the new person is listed by name', list1.body.people.some((p) => p.name === 'carol'));
  check('the key is never listed', !/carol-|glm-partner-/.test(JSON.stringify(list1.body.people.map((p) => p.key))),
    'no key field');
  check('the listing says where the directory is stored',
    !!list1.body.storage && list1.body.storage.file === STATE_FILE, JSON.stringify(list1.body.storage));

  const carolR = await signIn('partner', carolKey, 'carol');
  check('the created person signs in under their own name',
    carolR.status === 200 && carolR.body.name === 'carol', JSON.stringify(carolR.body));

  const madeByPartner = await api('POST', '/people', { name: 'eve', role: 'admin' }, partnerR.cookie);
  check('a partner cannot create people (403)', madeByPartner.status === 403, 'HTTP ' + madeByPartner.status);
  const noSession = await api('POST', '/people/revoke', { name: 'carol' }, null);
  check('revocation needs a session (401)', noSession.status === 401, 'HTTP ' + noSession.status);

  /* ── the socket dies with the person ── */
  const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/minter/ws', { headers: { cookie: carolR.cookie } });
  let socketClosed = null;
  ws.onclose = (ev) => { socketClosed = ev.code || 1005; };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
  };
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('socket failed'));
    setTimeout(() => rej(new Error('socket never opened')), 5000);
  });
  ws.send(JSON.stringify({ type: 'hello', ip: '203.0.113.44', proto: 2 }));
  await sleep(200);
  check('the person can open a mint socket while they hold the key', socketClosed === null);

  /* ── revoke, and prove the live session dies too ── */
  const rev = await api('POST', '/people/revoke', { name: 'carol' }, adminR.cookie);
  check('an admin revokes the person', rev.status === 200 && rev.body.ok === true, JSON.stringify(rev.body));
  check('revocation reports the session it dropped', rev.body.sessions >= 1, 'sessions=' + rev.body.sessions);
  check('revocation closed the live socket', rev.body.sockets === 1, 'sockets=' + rev.body.sockets);

  const keyAfter = await signIn('partner', carolKey, 'carol');
  check('the revoked key is refused on the next sign-in (401)', keyAfter.status === 401, 'HTTP ' + keyAfter.status);

  const staleCookie = await api('GET', '/status/self', undefined, carolR.cookie);
  check('the revoked person\'s existing cookie is dead too (401)',
    staleCookie.status === 401, 'HTTP ' + staleCookie.status);

  check('the socket was closed by the hub, not left hanging',
    socketClosed !== null, 'close code=' + socketClosed);

  const list2 = await api('GET', '/people', undefined, adminR.cookie);
  check('the revoked person is gone from the directory',
    !list2.body.people.some((p) => p.name === 'carol'));

  const again = await api('POST', '/people/revoke', { name: 'carol' }, adminR.cookie);
  check('revoking someone twice is a clean 400, not a crash',
    again.status === 400 && again.body.ok === false, JSON.stringify(again.body));

  /* ── rotate ── */
  const madeDana = await api('POST', '/people', { name: 'dana', role: 'partner' }, superR.cookie);
  const danaKey = madeDana.body.key;
  const danaR = await signIn('partner', danaKey, 'dana');
  check('dana signs in with her first key', danaR.status === 200, 'HTTP ' + danaR.status);

  const rot = await api('POST', '/people/rotate', { name: 'dana' }, adminR.cookie);
  check('an admin rotates the key', rot.status === 200 && rot.body.ok === true, JSON.stringify(rot.body));
  check('rotation returns a new key once', typeof rot.body.key === 'string' && rot.body.key !== danaKey);
  check('rotation dropped her live session', rot.body.sessions >= 1, 'sessions=' + rot.body.sessions);

  const oldDana = await signIn('partner', danaKey, 'dana');
  check('the old key stops working after rotation (401)', oldDana.status === 401, 'HTTP ' + oldDana.status);
  const newDana = await signIn('partner', rot.body.key, 'dana');
  check('the new key works after rotation', newDana.status === 200, 'HTTP ' + newDana.status);
  const staleDana = await api('GET', '/status/self', undefined, danaR.cookie);
  check('the session issued under the old key is dead', staleDana.status === 401, 'HTTP ' + staleDana.status);

  /* ── env-pinned people are the environment's to change ── */
  const pinRev = await api('POST', '/people/revoke', { name: 'pinned' }, adminR.cookie);
  check('an env-pinned person cannot be revoked from the API (400)',
    pinRev.status === 400 && /pinned/.test(pinRev.body.reason || ''), JSON.stringify(pinRev.body));
  const pinRot = await api('POST', '/people/rotate', { name: 'pinned' }, adminR.cookie);
  check('an env-pinned person cannot be rotated from the API (400)',
    pinRot.status === 400 && /pinned/.test(pinRot.body.reason || ''), JSON.stringify(pinRot.body));
  const pinnedStill = await signIn('partner', 'pinned-secret', 'pinned');
  check('the pinned key still works after those refusals', pinnedStill.status === 200, 'HTTP ' + pinnedStill.status);
  const pinList = await api('GET', '/people', undefined, adminR.cookie);
  check('the listing marks which people came from the environment',
    pinList.body.people.find((p) => p.name === 'pinned').pinned === true);

  /* ── what the admin panel actually reads ── */
  // admin.js renders its People card from /status.people.list, not /people, so
  // the shape the panel depends on is asserted here rather than assumed.
  const st = await api('GET', '/status', undefined, adminR.cookie);
  check('/status carries a people list for the panel',
    Array.isArray(st.body.people && st.body.people.list), JSON.stringify(Object.keys(st.body.people || {})));
  const rootRow = (st.body.people.list || []).find((p) => p.name === 'root');
  check('each row has the fields the panel renders',
    !!rootRow && typeof rootRow.role === 'string' && typeof rootRow.pinned === 'boolean'
      && typeof rootRow.uses === 'number' && typeof rootRow.donations === 'number',
    JSON.stringify(rootRow));
  check('/status says the directory is file-backed',
    /file-backed/.test(String(st.body.people.storage)), String(st.body.people.storage));
  check('/status never carries a key', !/glm-(partner|admin|superadmin)-[0-9a-f]{8}/.test(JSON.stringify(st.body.people)));

  const adminRevokesSuper = await api('POST', '/people/revoke', { name: 'root' }, adminR.cookie);
  check('an admin may not revoke a superadmin (403)', adminRevokesSuper.status === 403,
    'HTTP ' + adminRevokesSuper.status);

  /* ── the file ── */
  check('the state file was written', existsSync(STATE_FILE));
  const onDisk = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  check('the file holds the surviving people', onDisk.people.some((p) => p.name === 'dana'));
  check('the file does not hold the revoked person', !onDisk.people.some((p) => p.name === 'carol'));
  check('the file does not hold env-pinned people', !onDisk.people.some((p) => p.name === 'pinned'));
  const diskText = readFileSync(STATE_FILE, 'utf8');
  check('the file stores a salt and a hash, never the key itself',
    onDisk.people.some((p) => p.salt && p.hash && !('key' in p))
    && !diskText.includes(rot.body.key) && !diskText.includes('test-super-key')
    && onDisk.version === 2, 'version=' + onDisk.version);

  /* ── restart: revocation must survive, not resurrect ── */
  await stopHub(hub);
  hub = startHub();
  check('hub restarts with the same state file', await waitUp());

  const danaAfterRestart = await signIn('partner', rot.body.key, 'dana');
  check('a surviving person still signs in after a restart', danaAfterRestart.status === 200,
    'HTTP ' + danaAfterRestart.status);
  const carolAfterRestart = await signIn('partner', carolKey, 'carol');
  check('a revoked key is still refused after a restart',
    carolAfterRestart.status === 401, 'HTTP ' + carolAfterRestart.status);

  const superR2 = await signIn('superadmin', 'test-super-key');
  check('the pinned superadmin still signs in after a restart', superR2.status === 200, 'HTTP ' + superR2.status);
  const listAfter = await api('GET', '/people', undefined, superR2.cookie);
  check('the directory reloaded from the file', listAfter.body.people.some((p) => p.name === 'dana'));

  /* ── the seed: a superadmin account with no environment variable ──
   * First run on a fresh file generates one and prints it once; the file keeps
   * only the hash, so the same key still works after a restart. */
  await stopHub(hub);
  try { rmSync(SEED_FILE, { force: true }); } catch { /* fine */ }
  hub = startHub({ GLM_STATE_FILE: SEED_FILE, GLM_SUPERADMIN: '' });
  check('a first run with no GLM_SUPERADMIN still seeds a superadmin', await waitUp());
  const seedKey = (hubOut.match(/superadmin key \(printed once\): (\S+)/) || [])[1];
  check('the generated superadmin key is printed once', typeof seedKey === 'string' && seedKey.length > 20);
  const firstSeed = await signIn('superadmin', seedKey);
  check('the seeded superadmin signs in', firstSeed.status === 200, 'HTTP ' + firstSeed.status);
  await stopHub(hub);
  hub = startHub({ GLM_STATE_FILE: SEED_FILE, GLM_SUPERADMIN: '' });
  check('the hub restarts on the same file', await waitUp());
  check('the second run prints no new superadmin key', !/superadmin key \(printed once\)/.test(hubOut));
  const secondSeed = await signIn('superadmin', seedKey);
  check('the seeded superadmin still signs in after a restart', secondSeed.status === 200,
    'HTTP ' + secondSeed.status);
  const seedList = await api('GET', '/people', undefined, secondSeed.cookie);
  check('the panel is told the account lives in the state file, not the environment',
    (seedList.body.people.find((p) => p.name === 'root') || {}).source === 'state file (seed)',
    JSON.stringify(seedList.body.people.map((p) => [p.name, p.source])));
  const wrongSeed = await signIn('superadmin', 'glm-superadmin-0000000000000000');
  check('a wrong key is still refused at the top role', wrongSeed.status === 401,
    'HTTP ' + wrongSeed.status);

  /* ── a v1 file (plain keys) upgrades in place and still signs in ── */
  await stopHub(hub);
  try { rmSync(SEED_FILE, { force: true }); } catch { /* fine */ }
  writeFileSync(SEED_FILE, JSON.stringify({ version: 1, people: [
    { name: 'legacy', role: 'partner', key: 'legacy-secret-key', at: Date.now(), uses: 0 },
    { name: 'broken', role: 'partner', salt: 'not-hex', hash: 'not-hex', at: Date.now(), uses: 0 },
  ] }));
  hub = startHub({ GLM_STATE_FILE: SEED_FILE, GLM_SUPERADMIN: '' });
  check('a v1 state file still starts the hub', await waitUp());
  const legacy = await signIn('partner', 'legacy-secret-key', 'legacy');
  check('a key from a v1 file still signs in after the upgrade', legacy.status === 200,
    'HTTP ' + legacy.status);
  const migrated = readFileSync(SEED_FILE, 'utf8');
  check('the v1 plaintext key on disk is replaced by its hash',
    !migrated.includes('legacy-secret-key') && JSON.parse(migrated).version === 2);
  const broken = await signIn('partner', 'not-hex', 'broken');
  check('a malformed credential in the file is ignored, not a crash', broken.status === 401,
    'HTTP ' + broken.status);
} catch (e) {
  console.log('FAIL (exception) ' + (e && e.message));
  console.log(hubOut);
  failures++;
} finally {
  if (hub) await stopHub(hub);
  try { rmSync(STATE_FILE, { force: true }); } catch { /* fine */ }
  try { rmSync(STATE_FILE + '.tmp', { force: true }); } catch { /* fine */ }
  try { rmSync(SEED_FILE, { force: true }); } catch { /* fine */ }
  try { rmSync(SEED_FILE + '.tmp', { force: true }); } catch { /* fine */ }
}

console.log(failures === 0
  ? '\npeople check: revocation is immediate and survives a restart'
  : '\npeople check: ' + failures + ' problem(s)');
process.exit(failures === 0 ? 0 : 1);
