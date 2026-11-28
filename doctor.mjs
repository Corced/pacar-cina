// doctor.mjs - one command that says what is still open and what to type next.
//
// Every gap in docs/archive/HANDOFF.md needs something this machine does not have yet: an
// upstream credential, a real browser, a proxy, a long observation. Finding
// that out by reading seven runbooks is the friction this removes. It reads
// the note (never edits it), probes only what needs no secret, and starts its
// own hub on a spare port for the one command that does.
//
//   node doctor.mjs                 what is open, and what would close it
//   node doctor.mjs live [model]    one real chat call against GLM_UPSTREAM
//   node doctor.mjs --self-test     quiet assertions (run by npm run check)
//
// `live` never prints the key and never writes anything: it spawns the hub,
// makes the one call, prints the answer, and kills the hub.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
let failures = 0;

/* ── reading the note ─────────────────────────────────────────────────────── */

/* The gap list lives in one place; parsing it means this can never claim a gap
 * is open after someone deleted it, or miss one they added. */
function gaps(text) {
  const out = [];
  const re = /^### (\d+)\. (.+)$/gm;
  let m;
  while ((m = re.exec(text))) out.push({ n: Number(m[1]), title: m[2].trim() });
  return out.sort((a, b) => a.n - b.n);
}

/* What closes each gap, in the shortest form that is still true. Keyed by the
 * number in the note; an unknown number falls back to "read the runbook", which
 * is always correct. */
function closing(n) {
  return {
    1: 'a credential: contribute one with POST /upstream/keys, or set GLM_UPSTREAM + GLM_UPSTREAM_KEY, then `node doctor.mjs live`',
    2: 'a real browser: docs/archive/HANDOFF.md gap 2 (sign in, watch /minter/ws, verify the param)',
    3: 'the same credential, once per suffix: `node doctor.mjs live z.ai/glm-4.7-think`',
    4: 'time and a screenshot: docs/archive/HANDOFF.md gap 4 (30 min tab, 390 px diff)',
    5: 'a chatglm.cn credential: `node doctor.mjs live cn/glm-4.7`',
  }[n] || 'docs/archive/HANDOFF.md, gap ' + n;
}

/* ── the little pure bits, so --self-test can hold them ───────────────────── */

function mask(key) {
  const k = String(key || '');
  if (k.length < 12) return k ? '•••' : '';
  return k.slice(0, 4) + '…' + k.slice(-3);
}

/* A status code is not a verdict: 200 is the only thing that proves the path,
 * and 501/502 mean different things to whoever is reading the output. */
function classify(status) {
  if (status === 200) return 'proven';
  if (status === 501) return 'not configured';
  if (status === 502) return 'unreachable';
  if (status === 429) return 'throttled';
  return 'refused';
}

function stateFileFacts(file) {
  if (!file) return { set: false, text: 'GLM_STATE_FILE is not set: the directory lives only in memory' };
  if (!existsSync(file)) return { set: true, text: file + ' does not exist yet (it is written on the first change)' };
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    return { set: true, text: file + ' is not readable JSON: ' + (e && e.message) };
  }
  const people = Array.isArray(doc.people) ? doc.people.length : 0;
  const seed = doc.seed ? 'seed present' : 'no seed';
  return { set: true, text: file + ' version ' + (doc.version || '?') + ': ' + people + ' people, ' + seed };
}

/* ── report ───────────────────────────────────────────────────────────────── */

function report() {
  const notePath = join(ROOT, 'docs/archive/HANDOFF.md');
  const note = readFileSync(notePath, 'utf8');
  const list = gaps(note);

  console.log('glm2api doctor  ' + new Date().toISOString().slice(0, 10)
    + '  node ' + process.version + '  (no dependencies)');
  console.log('');
  console.log('Open gaps in docs/archive/HANDOFF.md: ' + list.length + '   (run `npm run check` for what is proven)');
  console.log('');
  for (const g of list) {
    console.log('  ' + String(g.n).padEnd(2) + ' ' + g.title);
    console.log('     closes with: ' + closing(g.n));
  }
  console.log('');

  console.log('What this machine has right now');
  const up = process.env.GLM_UPSTREAM || '';
  const key = process.env.GLM_UPSTREAM_KEY || '';
  console.log('  upstream   ' + (up
    ? up + (key ? ' (key ' + mask(key) + ')' : ' (no key: only anonymous calls will work)')
    : 'not set - chat answers 501, and `live` cannot run'));
  if (up && !key) {
    console.log('             set the key from a signed-in request\'s Authorization header, then rerun');
  }
  console.log('  directory  ' + stateFileFacts(process.env.GLM_STATE_FILE).text);
  console.log('  build      ' + (existsSync(join(ROOT, 'dist', 'index.html'))
    ? 'dist/ exists'
    : 'dist/ is not built yet: `npm run build`'));
  console.log('');

  const ready = [];
  if (!up) {
    ready.push('$env:GLM_UPSTREAM=\'https://chat.z.ai\'; $env:GLM_UPSTREAM_KEY=\'<the bearer value>\'');
    ready.push('node doctor.mjs live            # gap 1, and gap 5 with a cn/ model');
  } else {
    ready.push('node doctor.mjs live            # gap 1, and gap 5 with a cn/ model');
    if (key) ready.push('node doctor.mjs live z.ai/glm-4.7-think   # gap 3, once per suffix');
  }
  console.log('Next commands');
  for (const line of ready) console.log('  ' + line);
  return 0;
}

/* ── live: one real call, no secrets printed ──────────────────────────────── */

async function live(modelArg) {
  const origin = process.env.GLM_UPSTREAM || '';
  const key = process.env.GLM_UPSTREAM_KEY || '';
  const model = modelArg || process.env.DOCTOR_MODEL || 'z.ai/glm-4.7';
  if (!origin) {
    console.log('GLM_UPSTREAM is not set, so there is nowhere to send the call.');
    console.log('  $env:GLM_UPSTREAM=\'https://chat.z.ai\'');
    console.log('  $env:GLM_UPSTREAM_KEY=\'<the Authorization: Bearer value>\'');
    console.log('  node doctor.mjs live');
    return 2;
  }
  console.log('target  ' + origin + '  key ' + (key ? mask(key) : '(none)') + '  model ' + model);

  // Reachability first: a blocked network and a refused credential look the
  // same from a 502, and they are fixed by different people.
  let reach = 'unreachable';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(origin, { method: 'GET', redirect: 'manual', signal: ctrl.signal });
    clearTimeout(t);
    reach = 'answers HTTP ' + r.status;
  } catch (e) {
    reach = 'unreachable (' + (e && e.name === 'AbortError' ? 'timed out' : (e && e.message)) + ')';
  }
  console.log('reach   ' + reach);
  if (reach === 'unreachable' || reach.startsWith('unreachable')) {
    console.log('A network problem: fix that before blaming the credential.');
    return 1;
  }

  // A spare port, one hub at a time. The hub is a child process with the two
  // variables this run needs, so nothing is left behind in the environment.
  const base = await startHub(origin, key);
  if (!base) {
    console.log('could not start a hub on ports 5260-5264: is one already running?');
    return 1;
  }
  try {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'say ok' }] }),
    });
    const text = await r.text();
    const verdict = classify(r.status);
    console.log('');
    console.log('HTTP ' + r.status + '  ' + verdict
      + '  x-glm-pool: ' + (r.headers.get('x-glm-pool') || '-'));
    console.log(text.slice(0, 500) + (text.length > 500 ? ' …' : ''));
    console.log('');
    if (verdict === 'proven') {
      console.log('PROVEN: a real completion came back. Record it in docs/archive/HANDOFF.md, gap 1:');
      console.log('  ' + new Date().toISOString().slice(0, 10) + '  ' + model + '  -> 200, x-glm-pool='
        + (r.headers.get('x-glm-pool') || '-'));
      console.log('Then delete that gap (and lower the gap floor in check-docs.mjs in the same edit).');
    } else if (verdict === 'not configured') {
      console.log('501 means the hub did not receive GLM_UPSTREAM. Check the variable name and rerun.');
    } else if (verdict === 'unreachable') {
      console.log('502 means the hub could not reach the origin: the network is the problem, not the key.');
    } else {
      console.log('The upstream answered ' + r.status + '. Record that exact code and message: it is');
      console.log('either the credential or the signature, and the body above says which.');
    }
    return verdict === 'proven' ? 0 : 1;
  } finally {
    if (hub && hub.exitCode === null) {
      hub.kill('SIGTERM');
      // Wait for it: exiting while the child's pipes are mid-close trips a
      // libuv assertion on Windows.
      await new Promise((done) => hub.once('exit', done));
    }
  }
}

let hub = null;
async function startHub(origin, key) {
  for (const port of [5260, 5261, 5262, 5263, 5264]) {
    const base = 'http://' + HOST + ':' + port;
    const child = spawn(process.execPath, [join(ROOT, 'server', 'hub.mjs')], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST,
        GLM_UPSTREAM: origin,
        GLM_UPSTREAM_KEY: key,
        // A throwaway account and no state file: this hub must not mint a key
        // that gets printed once and lost, and must not write to a real
        // directory the operator keeps.
        GLM_STATE_FILE: '',
        GLM_SUPERADMIN: 'doctor:glm-doctor-throwaway-key',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d.toString(); });
    child.stderr.on('data', (d) => { log += d.toString(); });
    hub = child;
    for (let i = 0; i < 40; i++) {
      if (child.exitCode !== null) break;
      try {
        // /status/self answers 401 without a session, and that is still proof
        // the process is listening: only a refused connection counts as down.
        await fetch(base + '/status/self');
        const line = log.split('\n').find((l) => /upstream:/.test(l));
        if (line) console.log('hub     ' + line.trim());
        return base;
      } catch { /* not up yet */ }
      await sleep(100);
    }
    child.kill('SIGTERM');
    hub = null;
  }
  return null;
}

/* ── self-test ────────────────────────────────────────────────────────────── *
 * Quiet by design: it runs inside `npm run check`, where only failures should
 * be audible. */
function selfTest() {
  const note = readFileSync(join(ROOT, 'docs/archive/HANDOFF.md'), 'utf8');
  const list = gaps(note);
  const ok = (name, cond, detail) => {
    if (cond) { console.log('ok   ' + name); return; }
    failures++;
    console.log('FAIL ' + name + (detail ? '  - ' + detail : ''));
  };

  ok('the note still lists its numbered gaps', list.length >= 5, 'found ' + list.length);
  ok('every gap has a title', list.every((g) => g.title.length > 8), JSON.stringify(list.map((g) => g.n)));
  ok('every gap has a way to close it', list.every((g) => closing(g.n).length > 10));
  ok('an unknown gap number still points at the runbook', closing(99) === 'docs/archive/HANDOFF.md, gap 99', closing(99));
  ok('a long key is masked, not printed',
    mask('glm-superadmin-0123456789abcdef') === 'glm-…def'
      && !mask('glm-superadmin-0123456789abcdef').includes('superadmin'),
    mask('glm-superadmin-0123456789abcdef'));
  ok('a short value is masked entirely', mask('abc') === '•••', mask('abc'));
  ok('an empty key masks to empty', mask('') === '');
  ok('200 is the only proven status',
    classify(200) === 'proven' && classify(501) === 'not configured'
      && classify(502) === 'unreachable' && classify(403) === 'refused',
    [200, 501, 502, 403].map(classify).join(','));
  ok('a missing state file is described, not invented',
    stateFileFacts(join(ROOT, 'no-such-state.json')).text.includes('does not exist'),
    stateFileFacts(join(ROOT, 'no-such-state.json')).text);

  console.log(failures === 0 ? 'doctor self-test: the report reads the note it claims to'
    : 'doctor self-test: ' + failures + ' problem(s)');
  return failures === 0 ? 0 : 1;
}

const arg = process.argv[2] || '';
process.exitCode = arg === '--self-test'
  ? selfTest()
  : arg === 'live'
    ? await live(process.argv[3])
    : report();