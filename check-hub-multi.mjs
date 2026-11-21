/* check-hub-multi.mjs — the claim the whole project rests on: one hub, several
 * partner browsers, work spread across them and no job done twice.
 *
 * Connects three fake partners with different egress IPs, watches a burst of
 * mints, then asserts:
 *   - every partner got work (so it isn't all landing on one browser)
 *   - the number of mints equals the pool growth (no double-counting, no loss)
 *   - no job id was sent to two partners
 *   - in-flight returns to zero when the pool stops wanting work
 * Read-only apart from the temp hub it starts itself.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TEST_PORT || 5201);
const BASE = 'http://127.0.0.1:' + PORT;
const PARTNERS = 3;

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
    PUMP_MS: '60',
    TOKEN_TARGET: '30',
    GLM_KEYS: 'partner:test-partner-key,admin:test-admin-key',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let hubOut = '';
hub.stdout.on('data', (d) => { hubOut += d.toString(); });
hub.stderr.on('data', (d) => { hubOut += d.toString(); });

const jobIds = new Map();     // jobId -> partnerIndex  (detects a job sent twice)
const perPartner = [];        // mints answered, per partner
let duplicateJob = false;
const socks = [];

async function partnerCookie() {
  const r = await fetch(BASE + '/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'partner', key: 'test-partner-key' }),
  });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/status/self'); up = true; break; } catch { await sleep(100); }
  }
  check('hub starts', up);
  if (!up) throw new Error('hub never came up:\n' + hubOut);

  for (let i = 0; i < PARTNERS; i++) {
    perPartner.push(0);
    const cookie = await partnerCookie();
    const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/minter/ws', {
      headers: { cookie },
    });
    socks.push(ws);
    const idx = i;
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('partner ' + idx + ' socket failed'));
      setTimeout(() => rej(new Error('partner ' + idx + ' never opened')), 5000);
    });
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
      if (m.type === 'job') {
        if (jobIds.has(m.id)) duplicateJob = true;
        jobIds.set(m.id, idx);
        ws.send(JSON.stringify({
          type: 'captcha',
          id: m.id,
          param: '{"captchaVerifyParam":"p' + idx + '-' + m.id + '"}',
        }));
        perPartner[idx]++;
      }
    };
    ws.send(JSON.stringify({ type: 'hello', ip: '198.51.100.' + (10 + i), proto: 2 }));
  }
  await sleep(300);

  const adminR = await fetch(BASE + '/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'admin', key: 'test-admin-key' }),
  });
  const adminCookie = (adminR.headers.get('set-cookie') || '').split(';')[0];
  const getStatus = async () => (await fetch(BASE + '/status', {
    headers: { cookie: adminCookie },
  })).json();

  // Let the pump work through a burst, then wait for the steady state. The hub
  // stops asking once tokens + in-flight reach the target, so "settled" means
  // nothing in flight and every partner idle — a threshold alone would catch
  // the pool mid-burst, since several jobs are always in the air.
  let last = -1;
  for (let i = 0; i < 120; i++) {
    const s = await getStatus();
    const settled = s.minter.inflight === 0 && s.partners.every((p) => p.state === 'idle');
    if (settled && s.pool.available >= s.pool.target) break;
    if (settled && s.pool.available === last && i > 40) break;   // stalled below target
    last = s.pool.available;
    await sleep(150);
  }

  const s = await getStatus();

  check('more than one partner was used', s.partners.filter((p) => p.mints > 0).length > 1,
    'partners with mints: ' + s.partners.filter((p) => p.mints > 0).length);
  check('no job id was sent to two partners', duplicateJob === false);
  check('mints equal the sum answered by the partners',
    s.minter.served === perPartner.reduce((a, b) => a + b, 0),
    'hub served=' + s.minter.served + ', partners answered=' + perPartner.join('+'));
  check('each distinct egress IP is counted', s.minter.egressIps === PARTNERS,
    'egressIps=' + s.minter.egressIps);
  check('the pool stopped at its target',
    s.pool.available <= s.pool.target, 'available=' + s.pool.available + ' target=' + s.pool.target);
  check('nothing is left in flight when the pool is satisfied',
    s.minter.inflight === 0, 'inflight=' + s.minter.inflight);
  check('no jobs failed', s.minter.failed === 0, 'failed=' + s.minter.failed);
  check('every partner is idle at rest',
    s.partners.every((p) => p.state === 'idle'), s.partners.map((p) => p.state).join(','));

  for (const w of socks) w.close();
} catch (e) {
  console.log('FAIL (exception) ' + (e && e.message));
  console.log(hubOut);
  failures++;
} finally {
  hub.kill('SIGTERM');
  await sleep(250);
  if (!hub.killed) hub.kill('SIGKILL');
}

console.log(failures === 0 ? '\nmulti-partner check: all expectations met'
  : '\nmulti-partner check: ' + failures + ' problem(s)');
process.exit(failures === 0 ? 0 : 1);
