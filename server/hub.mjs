/* hub.mjs — the missing backend: one process, no dependencies.
 *
 * It answers exactly the contract the pages already speak, nothing invented:
 *
 *   WS  /minter/ws          the mint socket (see PROTOCOL below)
 *   GET /status             the JSON the admin page polls every 5 s
 *   POST /features          per-model feature toggles
 *   POST /admin/session/clear   drop every partner session
 *   POST /session           issue a session for a role (the login page's need)
 *   GET  /session           what the current session is, if any
 *   POST /v1/chat/completions   OpenAI-shaped stub; refuses honestly
 *   GET  /v1/models             the model list the admin page shows
 *   GET  /                      serve the static site out of public/
 *
 * PROTOCOL (/minter/ws), as the minter page implements it:
 *   client → {type:'hello', ip, proto:2}
 *   server → {type:'ping'}            client answers {type:'pong'}
 *   server → {type:'job', id, payload:{mint:true}}
 *   client → {type:'captcha', id, param}   or   {type:'error', id, kind, detail, code}
 *
 * Honest limits, stated because they matter:
 *   - A minted param is recorded and then *spent*, not validated first: the
 *     chat path puts it on the wire as captcha_verify_param, and only the
 *     upstream can say whether it was good. A 401/403/429 returns it to the
 *     pool, so a bad credential never burns it.
 *   - /v1 chat is forwarded only when GLM_UPSTREAM is set, and the call is
 *     proven against a local stub (check-chat.mjs), not against the live
 *     service: no credential ships with this project. Unset, the endpoint
 *     answers 501 with its reason rather than pretending.
 *   - Sessions are signed cookies plus a key registry, not accounts. Roles that
 *     carry privilege need their key (GLM_KEYS, GLM_PEOPLE), compared in
 *     constant time; `user` is open on purpose. A session lives in a Map and
 *     expires on its `GLM_SESSION_TTL_MS` age, checked server-side because the
 *     cookie's Max-Age is only a hint. Revocation is live (POST /people/revoke),
 *     and a revoked person's sessions and sockets go with the key.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptKey, attachSocket, newId } from './ws.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, '..', 'public');

const PORT = Number(process.env.PORT || 5082);
const HOST = process.env.HOST || '127.0.0.1';
const FE_VERSION = process.env.FE_VERSION || 'prod-fe-1.1.79';

/* ── deployment config ─────────────────────────────────────────────────────
 * Everything below is a value that used to be baked into the source. Each one
 * reads an environment variable and falls back to the value the original
 * capture showed, so a plain checkout behaves exactly as before while an
 * operator can point the hub somewhere else without editing code.
 *
 * The defaults are not guesses: they are what the recorded pages and the
 * Aliyun widget actually used, which is why the fallback keeps the faithful
 * behaviour rather than a placeholder. `GET /config` publishes the part the
 * browser needs; the rest stays server-side. */
const CONFIG = {
  captcha: {
    // The public verify endpoint and the scene/appkey the widget is built with.
    verifyUrl: process.env.GLM_CAPTCHA_VERIFY_URL
      || 'https://captcha.aliyun.com/captcha/v3/verify',
    scene: process.env.GLM_CAPTCHA_SCENE || 'no8xfe',
    appkey: process.env.GLM_CAPTCHA_APPKEY || 'FFFF0N00000000007EC0',
    prefix: process.env.GLM_CAPTCHA_PREFIX || 'didk33e0',
    region: process.env.GLM_CAPTCHA_REGION || 'sgp',
    lang: process.env.GLM_CAPTCHA_LANG || 'en',
    // Where the browser loads the SDK from. Pinned to the documented CDN, but
    // overridable so an air-gapped deploy can serve its own copy.
    sdkUrl: process.env.GLM_CAPTCHA_SDK_URL
      || 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js',
  },
  upstream: {
    // Header the real client sends; it is also what the upstream gates on.
    feVersion: FE_VERSION,
    region: process.env.GLM_REGION || 'overseas',
    sources: {
      'z.ai': {
        origin: process.env.GLM_ZAI_ORIGIN || 'https://chat.z.ai',
        path: process.env.GLM_ZAI_PATH || '/api/v2/chat/completions',
        region: process.env.GLM_ZAI_REGION || 'overseas',
      },
      cn: {
        origin: process.env.GLM_CN_ORIGIN || 'https://chatglm.cn',
        path: process.env.GLM_CN_PATH || '/api/v1/chat/completions',
        region: process.env.GLM_CN_REGION || 'cn',
      },
    },
  },
  models: {
    // Extra bases an operator adds show up in the catalog; the captured four
    // stay first so the default catalog is byte-for-byte the same list.
    extraBases: String(process.env.GLM_MODEL_EXTRA || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
  },
};

/* The session signing key. Ephemeral unless pinned, so a restart invalidates
 * every session — which is the safe default when there is no key store. */
const SECRET = process.env.SESSION_SECRET
  ? Buffer.from(process.env.SESSION_SECRET, 'utf8')
  : randomBytes(32);

const TARGET = Number(process.env.TOKEN_TARGET || 750);
const LOWWATER = Number(process.env.TOKEN_LOWWATER || 50);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 45000);

/* A pool entry stops being usable after this long, and a sweep moves it out of
 * `available` into `expired` — never silently dropped. 30 minutes matches how
 * long an Aliyun captcha answer is good for; the exact figure is Aliyun's
 * policy, so it is env-tunable rather than pretended to be known. */
const TOKEN_TTL_MS = Number(process.env.GLM_TOKEN_TTL_MS || 30 * 60 * 1000);
const SWEEP_MS = Number(process.env.GLM_SWEEP_MS || 15000);
/* How long a signed-in browser stays signed in. 24 hours was a literal; a
 * shared VPS and a laptop want different answers, so it is a setting. */
/* The public-IP lookup the pages use to show a visitor their own egress
 * address. It was a literal in two files; a deployment behind a firewall may
 * have to point it at its own service (or at nothing, and show "unavailable"). */
const IP_LOOKUP_URL = String(process.env.GLM_IP_LOOKUP_URL
  || 'https://api.ipify.org?format=json').trim();

const SESSION_TTL_MS = Number(process.env.GLM_SESSION_TTL_MS || 24 * 60 * 60 * 1000);

/* The superadmin: one account above admin, the only role that may manage the
 * directory. Seeded at startup from GLM_SUPERADMIN=name:key. With nothing set
 * a key is generated and printed once, exactly like the role keys — so the
 * default is unguessable rather than a blank account anyone can claim.
 *
 * Honest limit: there is no database. The seed lives in this process, so a
 * restart re-seeds it (a pinned key survives, a generated one is new). */
const SUPERADMIN_NAME = String(process.env.GLM_SUPERADMIN_NAME || 'root').trim() || 'root';

/* ── deployment identity ───────────────────────────────────────────────────
 * The pages must not guess where they live. On a VPS the hub is reached at a
 * name and a port the developer never saw, so every address a page displays is
 * built from what the hub knows at request time rather than from a literal.
 *
 * GLM_PUBLIC_URL is the escape hatch for when the hub sits behind a reverse
 * proxy or tunnel and cannot know its own outside name: set it once and every
 * page, snippet and /config answer uses it. Left unset, the hub reports the
 * host the request actually arrived on (X-Forwarded-* honoured when
 * GLM_TRUST_PROXY=1, because only then can those headers be believed).
 *
 * GLM_UPSTREAM is separate on purpose: it is the *target* the hub calls out to,
 * not the address this hub is reachable at. */
const PUBLIC_URL_OVERRIDE = String(process.env.GLM_PUBLIC_URL || '').trim().replace(/\/+$/, '');
const TRUST_PROXY = String(process.env.GLM_TRUST_PROXY || '').toLowerCase() === '1'
  || String(process.env.GLM_TRUST_PROXY || '').toLowerCase() === 'true';

/* The scheme the outside world uses. Behind TLS termination the socket is
 * plain http while the browser is on https, and a snippet that says http://
 * would be a lie (and a mixed-content warning). */
function requestScheme(req) {
  if (PUBLIC_URL_OVERRIDE) return '';
  if (TRUST_PROXY) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    if (proto) return proto + '://';
  }
  return (req.socket && req.socket.encrypted ? 'https://' : 'http://');
}

/* The host the page was reached at: the override if given, otherwise the
 * request's own Host header (which already carries a non-default port). */
function requestHost(req) {
  if (PUBLIC_URL_OVERRIDE) return PUBLIC_URL_OVERRIDE;
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    if (fwd) return requestScheme(req) + fwd;
  }
  const host = String(req.headers.host || '');
  if (host) return requestScheme(req) + host;
  // No Host header (a raw HTTP/1.0 client): fall back to what we bound to, and
  // say so rather than inventing a public name.
  return 'http://' + (HOST === '0.0.0.0' ? '127.0.0.1' : HOST) + ':' + PORT;
}

/* Everything a page or client needs to address this hub. `source` says which
 * rule produced it, so a deployment can tell "I set this" from "we guessed
 * from the Host header" instead of trusting a number silently. */
function deploymentInfo(req) {
  const base = requestHost(req);
  return {
    base,
    apiBase: base + '/v1',
    wsBase: base.replace(/^http/, 'ws'),
    listenHost: HOST,
    listenPort: PORT,
    ipLookup: IP_LOOKUP_URL,
    source: PUBLIC_URL_OVERRIDE ? 'GLM_PUBLIC_URL' : (TRUST_PROXY ? 'request host (proxy headers trusted)' : 'request Host header'),
    note: PUBLIC_URL_OVERRIDE
      ? 'set by GLM_PUBLIC_URL; the hub does not try to guess its outside name'
      : 'derived from the request, so it is correct wherever the hub is deployed; set GLM_PUBLIC_URL if a reverse proxy hides the real name',
  };
}

/* ── upstream (what /v1/chat/completions forwards to) ──────────────────────
 * Deliberately opt-in: with no GLM_UPSTREAM set, the hub keeps refusing with
 * 501 rather than guessing where to send chat traffic. The credential is
 * optional too — some upstreams (a local gateway) accept anonymous calls;
 * the hub only adds the Authorization header when GLM_UPSTREAM_KEY is set.
 * The chat path is fixed by the reference projects: /api/v2/chat/completions
 * on chat.z.ai, /api/v1/chat/completions on chatglm.cn. */
const UPSTREAM = {
  url: process.env.GLM_UPSTREAM || '',
  key: process.env.GLM_UPSTREAM_KEY || '',
  timeoutMs: Number(process.env.GLM_UPSTREAM_TIMEOUT || 30000),
};

/* Per-caller limit on chat: at most CHAT_CONCURRENCY requests in flight for one
 * identity, and after a refusal that identity waits CHAT_COOLDOWN_MS before it
 * may try again. One counter per person (or per role, or per IP when nobody is
 * signed in) in memory — the pool entries are the scarce resource, and a caller
 * with four open requests is already holding a quarter of the upstream's
 * attention. A cooldown exists so a client that ignores the 429 cannot simply
 * spin; it does not extend on repeat refusals. */
const CHAT_CONCURRENCY = Math.max(1, Number(process.env.GLM_CHAT_CONCURRENCY || 4) || 4);
const CHAT_COOLDOWN_MS = Math.max(0, Number(process.env.GLM_CHAT_COOLDOWN_MS || 5000) || 0);

/* A donation is verified by an outbound call to Aliyun, so a partner pasting a
 * hundred values turns into a hundred exchanges in flight. Cap how many one
 * caller may have verifying at once; the refusal records nothing and spends
 * nothing. Values that are not captcha-shaped never reach the network, so this
 * only ever bites a caller who is sending something that looks like a real
 * param — the exact case worth bounding. */
const DONATE_CONCURRENCY = Math.max(1, Number(process.env.GLM_DONATE_CONCURRENCY || 4) || 4);
const DONATE_RETRY_AFTER_S = 2;

/* Request signing for the z.ai wire format, as ported in both Go reference
 * projects (see repos.html): an HMAC-SHA256 over a sorted
 * `requestId,timestamp,user_id` string plus the base64 prompt, keyed by a
 * time-bucketed key derived from a fixed salt. The salt is the one those
 * projects ship; it is overridable because a deploy that talks to a different
 * origin will need its own. Until a real credential exists this is the only
 * part of the wire format that can be checked against the reference. */
const SIGN_SALT = process.env.GLM_SIGN_SALT || 'key-@@@@)))()((9))-xxxx&&&%%%%%';
const SIGN_BUCKET_MS = 300000;

/* The upstream key is a bearer token; the signature needs the account id from
 * inside it. A JWT carries `id` in its payload, a non-JWT yields '' — the
 * reference projects behave the same way when a token won't decode. */
function userIdFromToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return '';
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.id === 'string' ? payload.id : '';
  } catch { return ''; }
}

function randomUuid() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-'
    + hex.slice(16, 20) + '-' + hex.slice(20);
}

/* The prompt the signature covers: the reference flattens the messages, so the
 * signature stays valid whatever the message shape was. */
function promptOf(messages) {
  return (Array.isArray(messages) ? messages : []).map((m) => {
    const c = m && m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
    return '';
  }).filter(Boolean).join('\n\n').trim();
}

function signZai(prompt, token) {
  const timestamp = String(Date.now());
  const userID = userIdFromToken(token);
  const bucket = Math.floor(Date.now() / SIGN_BUCKET_MS);
  const wKey = createHmac('sha256', SIGN_SALT).update(String(bucket)).digest('hex');
  const dataToSign = 'requestId,' + randomUuid() + ',timestamp,' + timestamp
    + ',user_id,' + userID
    + '|' + Buffer.from(prompt, 'utf8').toString('base64')
    + '|' + timestamp;
  return createHmac('sha256', wKey).update(dataToSign).digest('hex');
}


/* ── the model catalog ─────────────────────────────────────────────────────
 * The person asked for model ids that say where they go and what they do:
 *   <source>/<base>[-suffix]   source: z.ai (chat.z.ai, overseas) or
 *                                      cn   (chatglm.cn)
 *                              base: glm-5.3, glm-5v-turbo, …
 *                              suffix: -think (thinking on), -search (web
 *                              search on), -deepresearch (deep research on)
 * Aliases are additive: glm-4.7 keeps working as a bare alias for z.ai/glm-4.7
 * so older clients never break. Suffixes are validated, unknown ones refused.
 * What a suffix maps to on the wire is upstream policy the hub can't prove
 * without a live upstream: it rewrites the model id and reports the flags in
 * /v1/models' metadata, honestly labelled as declared, not exercised. */
const SUFFIXES = [
  { name: '-think', feature: 'thinking' },
  { name: '-search', feature: 'web_search' },
  { name: '-deepresearch', feature: 'deep_research' },
];
const SOURCES = CONFIG.upstream.sources;
const BASE_MODELS = ['glm-5.3', 'glm-4.7', 'glm-4.6', 'glm-5v-turbo', ...CONFIG.models.extraBases];

function buildCatalog() {
  const out = [];
  for (const base of BASE_MODELS) {
    out.push({ id: 'z.ai/' + base, source: 'z.ai', base, features: [] });
    out.push({ id: 'cn/' + base, source: 'cn', base, features: [] });
    for (const s of SUFFIXES) {
      out.push({ id: 'z.ai/' + base + s.name, source: 'z.ai', base, features: [s.feature] });
      out.push({ id: 'cn/' + base + s.name, source: 'cn', base, features: [s.feature] });
    }
  }
  return out;
}
const CATALOG = buildCatalog();

/* Resolve a requested model id to {entry, declared} or null.
 * Accepts the full catalog ids, a bare base ("glm-4.7" → z.ai/glm-4.7),
 * and suffix order in any arrangement the id names. */
function resolveModel(id) {
  const requested = String(id || '').trim();
  if (!requested) return null;
  let hit = CATALOG.find((m) => m.id === requested);
  if (hit) return { entry: hit, declared: hit.features.slice() };
  // bare base name: default source is z.ai (what the original project spoke)
  hit = CATALOG.find((m) => m.base === requested && m.features.length === 0);
  if (hit) return { entry: hit, declared: [] };
  // a bare name with suffixes, e.g. "glm-5.3-search"
  for (const m of CATALOG) {
    if (m.features.length && requested === m.base + m.features.map((f) =>
      '-' + ({ thinking: 'think', web_search: 'search', deep_research: 'deepresearch' }[f])).join('')) {
      return { entry: m, declared: m.features.slice() };
    }
  }
  return null;
}


/* ── state ────────────────────────────────────────────────────────────────
 * In memory on purpose: there is no database, and pretending otherwise by
 * writing a file with credentials in it would be worse. Restart = empty pool. */

const state = {
  started: Date.now(),
  partners: new Map(),          // id -> {id, ip, proto, mints, lastSeen, state, socket, since}
  served: 0,
  inflight: 0,
  failed: 0,
  consumed: 0,
  expired: 0,
  tokens: [],                   // pool entries: {id, at, expiresAt, partnerId, size}
  donated: [],                  // partner-donated tokens/sessions, with verification status
  donatedSeq: 0,
  donateThrottled: 0,           // donations refused because that caller was already verifying
  verifying: new Map(),         // chatKey -> count of Aliyun exchanges in flight
  people: new Map(),            // person name -> {name, role, key, at, uses}
  chat: { requests: 0, ok: 0, failed: 0, throttled: 0, poolSpent: 0, lastModel: null, lastStatus: null, lastAt: null },
  captchaChecks: [],          // every Aliyun exchange attempted, with its outcome
  features: {
    // Defaults applied to every chat request; a model suffix can turn one on
    // for a single call. There is deliberately no persist_history here: the
    // reference bridge keeps that toggle to gate its own conversation store,
    // and this hub has none, so a switch for it would only ever be decoration.
    web_search: false,
    enable_thinking: true,
    preview_mode: false,
  },
  egress: { direct: true, proxy: false, tor: false, partners: true },
  models: ['glm-4.7', 'glm-4.6', 'glm-5v-turbo'],
  sessions: new Map(),          // sid -> {role, created, lastSeen}
  expiredSessions: 0,           // sign-ins that aged out, counted not dropped
  jobs: new Map(),              // jobId -> {id, partnerId, sentAt, timer}
  usage: new Map(),             // chatKey -> {active, until}: the per-caller limit
};

/* ── sessions ────────────────────────────────────────────────────────────── */

const ROLES = new Set(['user', 'partner', 'admin', 'superadmin']);

/* Admin-level privilege: superadmin is admin plus the extras below, so every
 * gate that says "admin" asks this instead of comparing the string. */
const ADMINISH = new Set(['admin', 'superadmin']);
function isAdminish(role) { return ADMINISH.has(role); }

/* ── identity: a key registry ─────────────────────────────────────────────
 * Roles used to be self-declared, so anyone reaching the port could claim
 * admin. Now a role that carries privilege needs its key.
 *
 *   GLM_KEYS=partner:some-secret,admin:another-secret
 *
 * user is deliberately open: lending your own IP is voluntary and grants no
 * access to anyone else's. partner and admin always need a key. If the
 * operator didn't supply one, the hub generates a random key at startup and
 * prints it — so the default is unguessable rather than blank. */
const KEY_ROLES = ['partner', 'admin', 'superadmin'];

/* ── the "database": one JSON document, and it never holds a key ───────────
 * There is no server and no schema here on purpose — the people directory and
 * the seeded superadmin live in one file, rewritten on every change. A key is
 * stored as a scrypt hash with a per-person salt, so a leaked copy is a list of
 * names rather than a set of working credentials. Keys that come from the
 * environment (GLM_KEYS, GLM_PEOPLE, GLM_SUPERADMIN) are the operator's own
 * secret store and are never copied into the file. */
const STATE_FILE = String(process.env.GLM_STATE_FILE || '').trim();

function hashKey(key, salt) {
  return scryptSync(String(key), Buffer.from(salt, 'hex'), 32).toString('hex');
}

function makeCredential(key) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: hashKey(key, salt) };
}

/* The file is input: a hand-edited salt would make scrypt throw on every
 * sign-in, so a stored credential is shape-checked before it is ever used. */
function validCred(salt, hash) {
  return typeof salt === 'string' && typeof hash === 'string'
    && /^[0-9a-f]{32}$/.test(salt) && /^[0-9a-f]{64}$/.test(hash);
}

function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/* One person against one presented key. `hash` is the normal case; a plaintext
 * `key` only exists for a person pinned in the environment. */
function credentialMatches(o, key) {
  if (!o || typeof key !== 'string') return false;
  if (o.hash) {
    if (!o.salt) return false;
    const a = Buffer.from(hashKey(key, o.salt), 'hex');
    const b = Buffer.from(o.hash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }
  return sameText(o.key, key);
}

/* The seed is read before the role keys are decided: an account already on file
 * means no fresh superadmin key should be generated, or the operator would be
 * handed a second key that duplicates the role and is not the durable one. */
function readSeed() {
  if (!STATE_FILE) return null;
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const s = parsed && parsed.seed;
    if (s && validCred(s.salt, s.hash)) return s;
  } catch { /* absent, unreadable or not JSON: no seed on file */ }
  return null;
}

const seedOnFile = readSeed();
const SEED_ON_FILE = seedOnFile && String(seedOnFile.name || 'root') === SUPERADMIN_NAME
  ? seedOnFile : null;

const KEYS = new Map();
for (const part of String(process.env.GLM_KEYS || '').split(',')) {
  const t = part.trim();
  if (!t) continue;
  const i = t.indexOf(':');
  if (i < 1) continue;
  const role = t.slice(0, i).trim().toLowerCase();
  const key = t.slice(i + 1).trim();
  if (ROLES.has(role) && key) KEYS.set(role, key);
}

const GENERATED = new Map();
for (const role of KEY_ROLES) {
  if (!KEYS.has(role)) {
    // A superadmin already on file is the account; generating another key here
    // would be a second valid one, printed once and then forgotten.
    if (role === 'superadmin' && !process.env.GLM_SUPERADMIN && SEED_ON_FILE) continue;
    const k = 'glm-' + role + '-' + randomBytes(12).toString('hex');
    KEYS.set(role, k);
    GENERATED.set(role, k);
  }
}

/* Seed the superadmin account. The order is deliberate: GLM_SUPERADMIN wins (a
 * key that survives a restart), then GLM_KEYS, then a generated key, then the
 * account already in the state file. Either way it is a real entry in the people
 * registry, so its name rides on sessions, mint sockets and donations. */
const SUPERADMIN_SEED_KEY = String(process.env.GLM_SUPERADMIN || '').trim();
const SUPERADMIN_KEY = SUPERADMIN_SEED_KEY || KEYS.get('superadmin') || '';
if (SUPERADMIN_SEED_KEY) KEYS.set('superadmin', SUPERADMIN_SEED_KEY);
const SUPERADMIN_SOURCE = SUPERADMIN_SEED_KEY ? 'GLM_SUPERADMIN'
  : GENERATED.has('superadmin') ? 'generated at startup'
  : KEYS.has('superadmin') ? 'GLM_KEYS'
  : 'the state file';

/* A role needs a key if anything could authenticate it: a role key, or a person
 * holding that role (a superadmin restored from the file has no role key). */
function needsKey(role) {
  if (KEYS.has(role)) return true;
  for (const o of state.people.values()) if (o.role === role) return true;
  return false;
}

/* Constant-time, one-way compare, so a wrong key leaks no timing about the right
 * one and the right one is never anywhere in memory as written. */
function checkKey(role, given) {
  // Any credential registered for the role grants it: the role's own GLM_KEYS
  // key, or a person's (hashed, or plaintext when it was pinned in the
  // environment). A role with nothing registered at all (user) stays open.
  // ponytail: one scrypt per person per attempt. Deliberately slow to *verify*,
  // so an unauthenticated caller pays too — this hub has no rate limiter, so put
  // one in the proxy if the directory ever grows past a handful of people.
  let registered = false;
  const roleKey = KEYS.get(role);
  if (roleKey) {
    registered = true;
    if (sameText(roleKey, given)) return true;
  }
  for (const o of state.people.values()) {
    if (o.role !== role) continue;
    registered = true;
    if (credentialMatches(o, given)) return true;
  }
  // The top role is never open by accident: a registry missing its superadmin
  // (a hand-edited file, a seed that failed to load) must lock, not widen.
  if (role === 'superadmin' && !registered) return false;
  return !registered;   // open role: no key exists to check
}

/* ── people: identity per person, not just per role ────────────────────────
 * The role registry says what a key can do; this says who holds it. Names are
 * the person's own word, not proof — the key is the proof. GLM_PEOPLE takes
 * name=role:key triples, comma-separated:
 *
 *   GLM_PEOPLE=alice=partner:s3cret,bob=admin:s3cret2
 *
 * Names join the session cookie, the mint socket and every donation, so the
 * admin panel can show who is behind each row instead of "partner". */
const PEOPLE_RE = /([A-Za-z0-9_.-]+)=(user|partner|admin|superadmin):([^,]+)/g;

/* ── the directory is mutable at runtime, and survives a restart ───────────
 * A revoked person's key stops working on the NEXT request, and their live
 * sessions and sockets are dropped with it — otherwise "revoked" would only
 * mean "until you reload". A key pinned in the environment always wins over
 * the file, so a restart cannot resurrect a revoked key from a stale copy. */

/* A person whose key came from outside the directory is not the file's to keep:
 * GLM_PEOPLE, GLM_SUPERADMIN or a superadmin key from GLM_KEYS. Revoking one
 * here would look like it worked while the key still authenticated. */
function pinnedReason(o) {
  if (o.seeded && o.name === SUPERADMIN_NAME) {
    return SUPERADMIN_SOURCE === 'the state file'
      ? o.name + ' is the seeded superadmin, kept in ' + STATE_FILE + '; it is the account of last resort and cannot be revoked or rotated from the API'
      : o.name + ' is the seeded superadmin (' + SUPERADMIN_SOURCE
        + '); change GLM_SUPERADMIN / GLM_KEYS and restart';
  }
  if (pinnedByEnv(o.name)) {
    return o.name + ' is pinned by GLM_PEOPLE; remove it there and restart';
  }
  return null;
}

function pinnedByEnv(name) {
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?:^|,)\\s*' + esc + '=').test(String(process.env.GLM_PEOPLE || ''));
}

/* Where a person's key actually lives, for the panel's Source column. "env"
 * means the key itself is the operator's and is not in the file; "seed" is the
 * superadmin in the state file; "file" and "memory" are the directory. */
function sourceOf(o) {
  if (pinnedByEnv(o.name)) return 'env (GLM_PEOPLE)';
  if (o.seeded && o.name === SUPERADMIN_NAME) {
    if (SUPERADMIN_SOURCE === 'the state file') return 'state file (seed)';
    if (SUPERADMIN_SOURCE === 'generated at startup') return 'generated key (printed once)';
    return 'env (' + SUPERADMIN_SOURCE + ')';
  }
  return STATE_FILE ? 'state file' : 'memory';
}

function pinnedPerson(o) {
  return pinnedReason(o) !== null;
}

function loadPeople() {
  if (!STATE_FILE) return;
  let raw;
  try { raw = readFileSync(STATE_FILE, 'utf8'); } catch { return; }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {
    log('state file is not JSON, ignoring it: ' + STATE_FILE);
    return;
  }
  let migrated = 0;
  const list = Array.isArray(parsed && parsed.people) ? parsed.people : [];
  // The file is input, so a salt or hash is checked before it is ever hashed
  // against: a hand-edited one would otherwise throw inside every sign-in.
  for (const o of list) {
    if (!o || !o.name || !ROLES.has(o.role)) continue;
    // v2 stores salt+hash; a v1 file kept the key itself, so hash it on the way
    // in and rewrite the file once. Old files keep working, without the keys.
    let cred = null;
    if (typeof o.hash === 'string' && typeof o.salt === 'string') {
      cred = validCred(o.salt, o.hash) ? { salt: o.salt, hash: o.hash } : null;
      if (!cred) log('ignoring a malformed credential for ' + o.name + ' in ' + STATE_FILE);
    } else if (o.key) { cred = makeCredential(String(o.key)); migrated++; }
    if (!cred) continue;
    state.people.set(o.name, {
      name: o.name, role: o.role, ...cred,
      at: Number(o.at) || Date.now(), uses: Number(o.uses) || 0,
      seeded: Boolean(o.seeded),
    });
  }
  const seed = parsed && parsed.seed;
  if (seed && validCred(String(seed.salt), String(seed.hash))) {
    const nm = String(seed.name || SUPERADMIN_NAME);
    if (!state.people.has(nm)) {
      state.people.set(nm, {
        name: nm, role: 'superadmin',
        salt: String(seed.salt), hash: String(seed.hash),
        at: Number(seed.at) || Date.now(), uses: Number(seed.uses) || 0,
        seeded: true,
      });
    }
  }
  if (list.length || seed) log('people directory loaded from ' + STATE_FILE + ' (' + Math.max(list.length, state.people.size) + ')');
  if (migrated) {
    savePeople();
    log(migrated + ' key(s) hashed on load; the file no longer holds any of them');
  }
}

/* Written on every mutation, not on every sign-in. The seeded superadmin gets
 * its own block rather than a row in `people`, because it is not the directory's
 * to drop — and `people` is exactly the set a revoke can delete. */
function savePeople() {
  if (!STATE_FILE) return;
  let seed = null;
  const people = [];
  for (const o of state.people.values()) {
    if (o.seeded && o.name === SUPERADMIN_NAME) {
      if (o.hash && o.salt) seed = { name: o.name, salt: o.salt, hash: o.hash, at: o.at, uses: o.uses };
      continue;
    }
    if (pinnedPerson(o)) continue;          // the environment's to keep, not the file's
    if (!o.hash || !o.salt) continue;       // only hashed credentials are written
    people.push({ name: o.name, role: o.role, salt: o.salt, hash: o.hash, at: o.at, uses: o.uses });
  }
  const doc = { version: 2, savedAt: Date.now(), people };
  if (seed) doc.seed = seed;
  const tmp = STATE_FILE + '.tmp';
  try {
    // 0600 anyway: the file is a directory of names and a place to guess at
    // hashes, and nothing else on the box needs it.
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, STATE_FILE);
  } catch (e) {
    log('could not write the state file (' + (e && e.message) + '); the directory is memory-only');
  }
}

function revokePerson(name) {
  const person = state.people.get(name);
  if (!person) return { ok: false, reason: 'no person named ' + name };
  if (pinnedPerson(person)) {
    return { ok: false, reason: 'cannot revoke: ' + pinnedReason(person) };
  }
  state.people.delete(name);
  let sessions = 0;
  for (const [sid, s] of state.sessions) {
    if (s.name === name) { state.sessions.delete(sid); sessions++; }
  }
  let sockets = 0;
  for (const p of state.partners.values()) {
    if (p.person === name && p.socket) { p.socket.close(1008, 'access revoked'); sockets++; }
  }
  savePeople();
  log('revoked ' + name + ' (' + person.role + '): ' + sessions + ' session(s), ' + sockets + ' socket(s) dropped');
  return { ok: true, name, role: person.role, sessions, sockets };
}

function rotatePerson(name) {
  const person = state.people.get(name);
  if (!person) return { ok: false, reason: 'no person named ' + name };
  if (pinnedPerson(person)) {
    return { ok: false, reason: 'cannot rotate: ' + pinnedReason(person).replace(/; (?:remove it there|change GLM_SUPERADMIN).*$/, '') };
  }
  // The new key exists in this response and nowhere afterwards: what is kept is
  // its hash, so a copy of the directory cannot be replayed as a sign-in.
  const key = 'glm-' + person.role + '-' + randomBytes(12).toString('hex');
  Object.assign(person, makeCredential(key));
  person.at = Date.now();
  // Every session dies with the old key, or a leaked cookie outlives the rotation.
  let sessions = 0;
  for (const [sid, s] of state.sessions) {
    if (s.name === name) { state.sessions.delete(sid); sessions++; }
  }
  savePeople();
  log('rotated the key for ' + name + ' (' + person.role + '), ' + sessions + ' session(s) dropped');
  return { ok: true, name, role: person.role, key, sessions };
}

loadPeople();
for (const m of String(process.env.GLM_PEOPLE || '').matchAll(PEOPLE_RE)) {
  const [, name, role, key] = m;
  // The environment wins over the file: a pinned person cannot be shadowed by
  // a key left behind in GLM_STATE_FILE.
  state.people.set(name, { name, role, key, at: Date.now(), uses: 0, pinned: true });
}

/* The seeded superadmin is ready the moment the hub starts. A key pinned with
 * GLM_SUPERADMIN always replaces whatever the file remembered; with nothing set,
 * an account already on file is kept (no new key, nothing printed), and only a
 * first run generates one and writes its hash back. */
const SEED_FROM_ENV = Boolean(SUPERADMIN_SEED_KEY)
  || (KEYS.has('superadmin') && !GENERATED.has('superadmin'));
if (SEED_FROM_ENV || (GENERATED.has('superadmin') && !state.people.has(SUPERADMIN_NAME))) {
  state.people.set(SUPERADMIN_NAME, {
    name: SUPERADMIN_NAME,
    role: 'superadmin',
    ...makeCredential(SUPERADMIN_KEY),
    at: Date.now(),
    uses: 0,
    seeded: true,
  });
}
// A generated seed is worthless after a restart unless its hash is on disk.
if (GENERATED.has('superadmin') && STATE_FILE) savePeople();

function sign(sid) {
  return createHmac('sha256', SECRET).update(sid).digest('base64url');
}

function issueSession(role, name) {
  const sid = newId(16);
  state.sessions.set(sid, { role, name: name || null, created: Date.now(), lastSeen: Date.now() });
  return sid + '.' + sign(sid);
}

/* Returns {sid, role} or null. Signature is checked in constant time, and the
 * age is checked here rather than left to the cookie: Max-Age is a client-side
 * hint, so anything replaying a raw cookie header would otherwise keep a
 * session forever. A leaked cookie now dies on schedule whatever the client
 * claims. */
function readSession(cookieHeader) {
  if (!cookieHeader) return null;
  const m = /(?:^|;\s*)glm_sid=([^;]+)/.exec(cookieHeader);
  if (!m) return null;
  const [sid, mac] = decodeURIComponent(m[1]).split('.');
  if (!sid || !mac) return null;
  const want = Buffer.from(sign(sid), 'utf8');
  const got = Buffer.from(mac, 'utf8');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const s = state.sessions.get(sid);
  if (!s) return null;
  if (Date.now() - s.created >= SESSION_TTL_MS) {
    state.sessions.delete(sid);
    state.expiredSessions++;
    return null;
  }
  s.lastSeen = Date.now();
  return { sid, role: s.role, name: s.name || null };
}

/* Sessions nobody has used in a whole TTL are gone. Without this the Map grows
 * for the life of the process: every sign-in leaves an entry nothing removes. */
function sweepSessions(now) {
  let moved = 0;
  for (const [sid, s] of state.sessions) {
    if (now - s.created >= SESSION_TTL_MS) { state.sessions.delete(sid); moved++; }
  }
  if (moved) {
    state.expiredSessions += moved;
    log(moved + ' session(s) expired (' + state.expiredSessions + ' total)');
  }
  return moved;
}

function countSessions() {
  return state.sessions.size;
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function json(res, code, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); resolve(null); return; }
      parts.push(c);
    });
    req.on('end', () => {
      if (!parts.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); }
      catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function log(line) {
  const t = new Date().toISOString().slice(11, 19);
  console.log('[' + t + '] ' + line);
}

/* ── the Aliyun captcha check ──────────────────────────────────────────────
 * What the reference projects do in-process (InitCaptchaV3 → arg → Verify-
 * CaptchaV3) needs their ported device-data generator. This hub instead runs
 * the real exchange against Aliyun's public API when the person asks for a
 * verification, so "valid" here means Aliyun actually answered. Nothing
 * invents a result: with no network or a wrong scene id, the status is
 * "unverified" with the reason, never a fabricated valid/invalid.
 *
 * The captchaVerifyParam the minter page returns is exactly what this API
 * expects in `data`. */
const CAPTCHA_API = CONFIG.captcha.verifyUrl;
const CAPTCHA_SCENE_DEFAULT = CONFIG.captcha.scene;
const CAPTCHA_APPKEY = CONFIG.captcha.appkey;

async function verifyCaptchaParam(param, sceneId) {
  const scene = sceneId || CAPTCHA_SCENE_DEFAULT;
  const out = { status: 'unverified', detail: '', checkedAt: Date.now(), scene };
  if (!param || typeof param !== 'string') {
    out.detail = 'no captchaVerifyParam supplied';
    return out;
  }
  const body = new URLSearchParams({
    sceneId: scene,
    appkey: CAPTCHA_APPKEY,
    data: param,
  }).toString();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(CAPTCHA_API, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const text = await r.text();
    let answer = null;
    try { answer = JSON.parse(text); } catch { /* non-json */ }
    if (r.ok && answer && (answer.code === 100 || answer.code === '100')) {
      out.status = 'valid';
      out.detail = 'aliyun answered code 100';
    } else if (r.ok && answer && answer.code !== undefined) {
      out.status = 'invalid';
      out.detail = 'aliyun answered code ' + answer.code + (answer.msg ? ' (' + answer.msg + ')' : '');
    } else {
      out.detail = 'aliyun answered HTTP ' + r.status;
    }
  } catch (e) {
    out.detail = 'network: ' + (e && e.name === 'AbortError' ? 'timed out after 8s' : 'could not reach ' + CAPTCHA_API);
  }
  return out;
}

/* A donated value may be the captchaVerifyParam the minter page returns
 * (wrapped in JSON) or a bare device token. Only the former can be exchanged
 * with Aliyun, so the shape is checked before anything is claimed. */
function captchaParamFrom(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('{')) {
    try {
      const o = JSON.parse(raw);
      const p = o && (o.captchaVerifyParam || o.param || o.data);
      if (typeof p === 'string' && p.trim()) return p.trim();
      return null;                       // JSON, but not a captcha answer
    } catch { return null; }             // not JSON after all: not captcha-shaped
  }
  // A bare Aliyun param is base64-ish and long; a short opaque token is not one.
  return /^[A-Za-z0-9+/=_.~-]{40,}$/.test(raw) ? raw : null;
}

/* Verify a donation as soon as it arrives, without keeping the value: it is in
 * memory for the length of this call and then dropped. The status it settles to
 * is whatever Aliyun said — valid, invalid, or unverified with the reason. */
async function verifyDonation(donation, value) {
  const param = captchaParamFrom(value);
  if (!param) {
    donation.status = 'unverified';
    donation.detail = 'not a captcha param; an admin exchange (POST /captcha/verify) can still try it';
    donation.checkedAt = Date.now();
    return donation;
  }
  let answer;
  try {
    answer = await verifyCaptchaParam(param);
  } catch (e) {
    donation.status = 'unverified';
    donation.detail = 'verify threw: ' + (e && e.message);
    donation.checkedAt = Date.now();
    return donation;
  }
  donation.status = answer.status;
  donation.detail = answer.detail || '';
  donation.checkedAt = answer.checkedAt || Date.now();
  return donation;
}

/* The exact shape admin.js reads in fillStatus(). Field names are its. */
function statusPayload(req) {
  const partners = [...state.partners.values()];
  const ips = new Set(partners.map((p) => p.ip).filter(Boolean));
  const now = Date.now();

  return {
    ok: true,
    // Where this hub is reachable, worked out from the request, so the panel
    // shows a real address on a VPS instead of a localhost literal.
    deploy: deploymentInfo(req),
    mode: state.egress.tor ? 'tor' : state.egress.proxy ? 'proxy' : state.egress.partners ? 'partners' : 'direct',
    port: PORT,
    user: process.env.USER || process.env.USERNAME || 'operator',    userName: process.env.USER || process.env.USERNAME || 'operator',
    feVersion: FE_VERSION,
    tokenCount: state.tokens.length,
    activeSessions: countSessions(),
    sessionTtlMs: SESSION_TTL_MS,
    expiredSessions: state.expiredSessions,
    uptimeSec: Math.floor((now - state.started) / 1000),
    authMode: [...KEYS.keys()].length
      ? 'keyed roles: ' + [...KEYS.keys()].sort().join(', ') + ' need a key; user is open'
      : 'no roles configured',
    wsAuth: String(process.env.GLM_WS_AUTH || 'required').toLowerCase() === 'open'
      ? 'OPEN — anonymous sockets may mint (GLM_WS_AUTH=open)'
      : 'a session is required on /minter/ws',
    people: {
      count: state.people.size,
      names: [...state.people.values()].map((o) => o.name + ' (' + o.role + ')'),
      list: [...state.people.values()].map((o) => ({
        name: o.name,
        role: o.role,
        uses: o.uses,
        pinned: pinnedPerson(o),
        source: sourceOf(o),
        donations: state.donated.filter((d) => d.person === o.name).length,
      })),
      storage: STATE_FILE ? 'file-backed (GLM_STATE_FILE)' : 'memory only (set GLM_STATE_FILE to keep it)',
      note: 'per-person identity; a person joins their donations, sessions and mint sockets',
    },
    superadmin: {
      name: SUPERADMIN_NAME,
      seeded: true,
      source: SUPERADMIN_SOURCE,
      key: SUPERADMIN_SOURCE === 'the state file'
        ? 'the key printed once when the account was seeded — only its hash is stored'
        : GENERATED.has('superadmin') || SUPERADMIN_SEED_KEY ? 'use the startup line (printed once)' : 'set by GLM_KEYS',
      note: SUPERADMIN_SEED_KEY
        ? 'seeded from GLM_SUPERADMIN; the key survives a restart because it is pinned'
        : SUPERADMIN_SOURCE === 'the state file'
          ? 'seeded from GLM_STATE_FILE: the account outlives a restart without an environment variable'
          : 'seeded at startup with a generated key printed once; setting GLM_STATE_FILE keeps it across restarts',
    },

    upstream: {
      configured: Boolean(UPSTREAM.url),
      url: UPSTREAM.url || null,
      note: UPSTREAM.url
        ? 'chat is forwarded to ' + UPSTREAM.url
        : 'set GLM_UPSTREAM to forward /v1/chat/completions; without it chat answers 501',
    },
    chat: state.chat,
    chatLimit: {
      concurrency: CHAT_CONCURRENCY,
      cooldownMs: CHAT_COOLDOWN_MS,
      inFlight: chatInFlight(),
      callers: state.usage.size,
      per: 'a person by name; a signed-in role; otherwise the client IP',
      note: 'a refused caller gets 429 with retry-after, then waits the cooldown before trying again',
    },
    donationLimit: {
      concurrency: DONATE_CONCURRENCY,
      verifying: [...state.verifying.values()].reduce((a, b) => a + b, 0),
      callers: state.verifying.size,
      throttled: state.donateThrottled,
      note: 'each captcha-shaped donation is one outbound Aliyun exchange; a caller past this many gets 429 and records nothing',
    },
    captcha: {
      api: CAPTCHA_API,
      checked: state.captchaChecks.length,
      valid: state.captchaChecks.filter((c) => c.status === 'valid').length,
      invalid: state.captchaChecks.filter((c) => c.status === 'invalid').length,
      note: 'a minted param can be exchanged with Aliyun via POST /captcha/verify; nothing is invented',
    },

    minter: {
      online: partners.filter((p) => p.state !== 'gone').length,
      served: state.served,
      inflight: state.inflight,
      failed: state.failed,
      egressIps: ips.size,
      jobTimeoutMs: JOB_TIMEOUT_MS,
      spread: state.inflight > 1 ? 'parallel' : 'serial',
    },

    pool: {
      available: state.tokens.length,
      target: TARGET,
      lowwater: LOWWATER,
      low: state.tokens.length < LOWWATER,
      consumed: state.consumed,
      expired: state.expired,
      ttlMs: TOKEN_TTL_MS,
      donatedTokens: state.donated.filter((d) => d.kind === 'token').length,
      donatedSessions: state.donated.filter((d) => d.kind === 'session').length,
      donatedValid: state.donated.filter((d) => d.status === 'valid').length,
      donatedInvalid: state.donated.filter((d) => d.status === 'invalid').length,
      donatedVerifying: state.donated.filter((d) => d.status === 'verifying').length,
      donatedUnverified: state.donated.filter((d) => d.status === 'unverified').length,
      note: 'each entry expires after ttlMs and moves to expired; below lowwater the hub asks partners for more; '
        + 'the chat path spends the oldest entry as captcha_verify_param and returns it on 401/403/429',
    },

    features: state.features,
    egress: state.egress,
    models: state.models,

    partners: partners.map((p) => ({
      id: p.id,
      ip: p.ip || '—',
      proto: p.proto,
      role: p.role || 'anonymous',
      person: p.person || null,
      mints: p.mints,
      lastSeen: Math.max(0, Math.round((now - p.lastSeen) / 1000)) + 's ago',
      state: p.state,
    })),
  };
}

/* ── the per-caller chat limit ───────────────────────────────────────────── */

/* Who the limit applies to. A named person has their own budget; a signed-in
 * role that is not a person shares one; anyone without a session is counted by
 * IP, which is the only identity an anonymous caller has (so two people behind
 * one NAT share a budget — the honest ceiling of IP counting). A forwarded
 * address is believed only when GLM_TRUST_PROXY says a proxy rewrote it. */
function chatKeyOf(req, session) {
  if (session && session.name) return 'person:' + session.name;
  if (session) return 'role:' + session.role;
  const fwd = TRUST_PROXY ? (req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const ip = fwd || (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return 'ip:' + ip;
}

function takeChatSlot(key) {
  const now = Date.now();
  let u = state.usage.get(key);
  if (!u) { u = { active: 0, until: 0 }; state.usage.set(key, u); }
  if (u.until > now) {
    return { ok: false, why: 'cooling', retryAfter: Math.ceil((u.until - now) / 1000) };
  }
  if (u.active >= CHAT_CONCURRENCY) {
    // Start the wait now; a repeat refusal does not extend it, or a client that
    // ignores the 429 could keep itself locked out forever.
    u.until = now + CHAT_COOLDOWN_MS;
    return { ok: false, why: 'busy', retryAfter: Math.ceil(CHAT_COOLDOWN_MS / 1000) };
  }
  u.active++;
  return { ok: true };
}

function releaseChatSlot(key) {
  const u = state.usage.get(key);
  if (!u) return;
  u.active = Math.max(0, u.active - 1);
  // Idle and past its cooldown: forget it, so the map holds only live callers.
  if (u.active === 0 && u.until <= Date.now()) state.usage.delete(key);
}

function chatInFlight() {
  let n = 0;
  for (const u of state.usage.values()) n += u.active;
  return n;
}

/* ── the token pool: consume, expire, refill ─────────────────────────────── */

/* Move entries past their expiry out of `available`. Counted, never dropped
 * silently, so /status shows exactly where they went. */
function sweepPool(now) {
  if (!state.tokens.length) return 0;
  const keep = [];
  let moved = 0;
  for (const t of state.tokens) {
    if (t.expiresAt && t.expiresAt <= now) moved++;
    else keep.push(t);
  }
  if (moved) {
    state.tokens = keep;
    state.expired += moved;
    log(moved + ' pool entr' + (moved === 1 ? 'y' : 'ies') + ' expired (' + state.expired + ' total)');
  }
  return moved;
}

/* Take one entry for use: oldest first, so the pool drains in the order it
 * filled and stale work can't pile up at the head. Returns the entry or null. */
function consumeToken() {
  sweepPool(Date.now());
  const entry = state.tokens.shift();
  if (!entry) return null;
  state.consumed++;
  return entry;
}

/* Ask connected partners for more work while the pool is under its low-water
 * mark. Called from the sweep and after every consume, so a drain refills
 * itself rather than waiting on the next poll. */
function refillPool() {
  let asked = 0;
  while (state.tokens.length + state.inflight < TARGET
    && state.tokens.length < LOWWATER
    && dispatchJob()) {
    asked++;
    if (asked > TARGET) break;      // safety: never loop forever
  }
  return asked;
}

/* The periodic sweep also tops the pool up, so a hub that nobody is poking
 * still keeps itself near target. */
const sweeper = setInterval(() => {
  sweepPool(Date.now());
  sweepSessions(Date.now());
  // Idle callers whose cooldown has passed hold no information: drop them, or
  // the map keeps one row per IP that ever got a 429.
  const now = Date.now();
  for (const [key, u] of state.usage) {
    if (u.active === 0 && u.until <= now) state.usage.delete(key);
  }
  refillPool();
}, SWEEP_MS);

/* ── mint job dispatch ───────────────────────────────────────────────────── */

function pickPartner() {
  // Least recently asked, so work spreads instead of landing on one browser.
  const live = [...state.partners.values()]
    .filter((p) => p.socket && p.state === 'idle' && !p.socket.closed);
  if (!live.length) return null;
  live.sort((a, b) => (a.lastAsked || 0) - (b.lastAsked || 0));
  return live[0];
}

function dispatchJob() {
  const p = pickPartner();
  if (!p) return false;
  // Pool full: stop asking. Count in-flight work too, or the last few jobs
  // all land at once and the pool overshoots its target.
  if (state.tokens.length + state.inflight >= TARGET) return false;

  const id = 'job-' + newId(5);
  p.state = 'busy';
  p.lastAsked = Date.now();
  state.inflight++;

  const timer = setTimeout(() => {
    state.jobs.delete(id);
    state.inflight = Math.max(0, state.inflight - 1);
    state.failed++;
    p.state = 'idle';
    log('job ' + id + ' timed out on partner ' + p.id);
  }, JOB_TIMEOUT_MS);

  state.jobs.set(id, { id, partnerId: p.id, sentAt: Date.now(), timer });
  p.socket.sendJson({ type: 'job', id, payload: { mint: true } });
  return true;
}

function finishJob(id, partner, outcome, detail) {
  const job = state.jobs.get(id);
  if (job) { clearTimeout(job.timer); state.jobs.delete(id); }
  state.inflight = Math.max(0, state.inflight - 1);
  if (partner) partner.state = 'idle';

  if (outcome === 'ok') {
    state.served++;
    if (partner) partner.mints++;
    // The param itself is kept: the chat path spends it as
    // `captcha_verify_param`, and a pool that cannot be spent is the one gap
    // this project existed to close. In memory only, like everything else.
    state.tokens.push({
      id: 'tok-' + newId(5),
      at: Date.now(),
      expiresAt: Date.now() + TOKEN_TTL_MS,
      partnerId: partner ? partner.id : null,
      person: partner ? partner.person : null,
      param: String(detail || ''),
      size: String(detail).length,
      source: 'mint',
    });
    // Over-collected entries age out through expiry, not by being dropped here.
    log('mint ok from ' + (partner ? partner.id : '?') + ' (' + state.tokens.length + ' available)');
    refillPool();
  } else {
    state.failed++;
    log('mint failed from ' + (partner ? partner.id : '?') + ': ' + detail);
  }
}

/* ── the socket ──────────────────────────────────────────────────────────── */

function onMinterSocket(conn, req, session) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

  const partner = {
    id: newId(4),
    ip: '',
    proto: 0,
    mints: 0,
    role: session ? session.role : 'anonymous',
    person: session && session.name ? session.name : null,
    lastSeen: Date.now(),
    lastAsked: 0,
    state: 'new',
    socket: conn,
    since: Date.now(),
  };
  state.partners.set(partner.id, partner);
  log('partner ' + partner.id + ' connected as ' + partner.role
    + (partner.person ? ' (' + partner.person + ')' : '')
    + ' from ' + ip
    + ' (' + state.partners.size + ' online)');

  conn.onMessage = (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    partner.lastSeen = Date.now();

    if (msg.type === 'hello') {
      partner.ip = String(msg.ip || ip).slice(0, 64);
      partner.proto = Number(msg.proto) || 0;
      partner.state = 'idle';
      if (partner.proto !== 2) {
        // The page sends proto 2. A mismatch is tolerated but recorded, since
        // a different protocol may mean different message types.
        log('partner ' + partner.id + ' speaks proto ' + partner.proto + ', not 2');
      }
      return;
    }

    if (msg.type === 'ping') { conn.sendJson({ type: 'pong' }); return; }
    if (msg.type === 'pong') { partner.state = 'idle'; return; }

    if (msg.type === 'captcha') {
      finishJob(msg.id, partner, 'ok', msg.param || '');
      // immediately offer the next job if the pool still wants one
      setTimeout(dispatchJob, 50);
      return;
    }

    if (msg.type === 'error') {
      finishJob(msg.id, partner, 'error', msg.detail || ('code ' + msg.code));
      return;
    }
  };

  conn.onClose = () => {
    partner.state = 'gone';
    partner.socket = null;
    // Fail any job that was in that browser's hands, rather than waiting it out.
    for (const [id, job] of state.jobs) {
      if (job.partnerId === partner.id) {
        clearTimeout(job.timer);
        state.jobs.delete(id);
        state.inflight = Math.max(0, state.inflight - 1);
        state.failed++;
      }
    }
    log('partner ' + partner.id + ' disconnected (' + state.partners.size + ' known)');
  };
}

/* Ask a partner for a mint. Called by the /v1 stub and by the timer. */
setInterval(() => {
  if (state.tokens.length + state.inflight < TARGET) dispatchJob();
}, Number(process.env.PUMP_MS || 8000)).unref();

/* ── static files ────────────────────────────────────────────────────────── */

/* Login first: a page is served only to a signed-in visitor. The sign-in page
 * and the assets it needs stay public, or nobody could ever get in. This is a
 * page gate only — the JSON routes each check their own role, and a purely
 * static deploy (no hub) has nothing to gate with, which the pages say. */
const PUBLIC_PATHS = new Set([
  '/login.html', '/roles.js', '/role.css', '/minter.css', '/favicon.ico',
]);
const PUBLIC_EXT = new Set(['.css', '.js', '.png', '.svg', '.ico', '.woff2', '.woff', '.map']);
function isGateOpen(rel) {
  if (PUBLIC_PATHS.has(rel)) return true;
  // Shared styling/scripts: a page cannot render or sign in without them.
  return !rel.endsWith('.html') && PUBLIC_EXT.has(extname(rel).toLowerCase());
}

/* ── role navigation ───────────────────────────────────────────────────────
 * Each role gets its own set of links, so an admin reading the operator panel
 * is never one stray click from a partner's donation form, and a partner never
 * sees the operator's numbers. The nav is written into the page by the hub
 * rather than drawn by a script, so it is already correct on the first paint:
 * no flash of the wrong links, and it still works if the page's own JS fails.
 *
 * It is a map for finding your way, not a lock. Every route enforces its own
 * role: hiding a link is convenience, and the checks prove the routes refuse. */
const ROLE_HOME = {
  user: { href: '/user.html', label: 'my page' },
  partner: { href: '/partner.html', label: 'my page' },
  admin: { href: '/admin.html', label: 'panel' },
  superadmin: { href: '/admin.html', label: 'panel' },
};

/* Pages that are nobody's "home" but that some roles may legitimately open. */
const SHARED_LINKS = {
  minter: { href: '/index.html', label: 'minter' },
  repos: { href: '/repos.html', label: 'reference repos' },
  login: { href: '/login.html', label: 'switch role' },
};

/* What one role may see. Deliberately exclusive: admin and superadmin are the
 * operator side and get no partner form; users and partners get no panel. */
function navFor(role) {
  const items = [];
  const home = ROLE_HOME[role];
  if (home) items.push(home);
  if (role === 'partner') {
    items.push({ href: '/user.html', label: 'IP lending' });
  }
  if (role === 'user' || role === 'partner') {
    items.push(SHARED_LINKS.minter);
  }
  if (role === 'admin' || role === 'superadmin') {
    items.push(SHARED_LINKS.minter);
    items.push(SHARED_LINKS.repos);
  }
  if (role) items.push(SHARED_LINKS.login);
  return items;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* The bar itself. `role` is null for a visitor with no session. */
function navBar(role, currentPath, name) {
  const items = navFor(role);
  const who = role
    ? esc(role) + (name ? ' · ' + esc(name) : '')
    : 'not signed in';
  const links = items.map((it) => {
    const here = it.href === currentPath ? ' class="navlink here" aria-current="page"' : ' class="navlink"';
    return '<a' + here + ' href="' + it.href + '">' + esc(it.label) + '</a>';
  }).join('');
  return '<div class="nav" data-role="' + esc(role || 'anonymous') + '">'
    + '<span class="navwho"><b>' + who + '</b></span>'
    + (links ? '<span class="navlinks">' + links + '</span>' : '')
    + '</div>';
}

/* Put the bar in place of the marker a page leaves for it. A page without the
 * marker is served untouched, so this can never mangle a file by accident. */
const NAV_MARKER = '<!--nav-->';
function withNav(html, role, currentPath, name) {
  if (html.indexOf(NAV_MARKER) === -1) return html;
  return html.split(NAV_MARKER).join(navBar(role, currentPath, name));
}

/* Where a visitor lands. The first thing anyone sees is the sign-in page: a
 * shared VPS URL should not drop a stranger onto a page whose job is unclear.
 * The original capture's page is still there at /index.html for anyone who
 * signs in, so nothing faithful was thrown away — only the front door moved. */
const LANDING = '/login.html';

/* A signed-in visitor who opens a page that belongs to another role is sent to
 * their own, with a note saying why, rather than shown a page that will only
 * refuse its data and look broken. */
const PAGE_ROLE = {
  '/admin.html': 'operator',
  '/partner.html': 'partner',
  '/user.html': 'lender',
};
function pageRoleFor(rel) {
  return PAGE_ROLE[rel] || null;
}
function roleFitsPage(role, needs) {
  if (!needs) return true;
  // Strict on purpose: the operator side and the partner side keep to their own
  // pages, which is the whole point of a bar that shows only your own links.
  if (needs === 'operator') return isAdminish(role);
  if (needs === 'partner') return role === 'partner';
  if (needs === 'lender') return role === 'user' || role === 'partner';
  return true;
}

async function serveStatic(req, res, pathname, session) {
  let rel = decodeURIComponent(pathname);
  // The front door is the sign-in page. A signed-in visitor is sent straight
  // to their own page, so "/" is never a dead end.
  if (rel === '/' || rel === '') {
    if (session) {
      const home = ROLE_HOME[session.role] || ROLE_HOME.user;
      res.writeHead(302, { location: home.href, 'cache-control': 'no-store' });
      res.end();
      return;
    }
    res.writeHead(302, { location: LANDING, 'cache-control': 'no-store' });
    res.end();
    return;
  }  // No traversal: resolve, then confirm it stays inside PUBLIC. This is checked
  // before the gate, so an escape attempt is refused rather than redirected —
  // a 302 to the login page would read as "log in and it'll work".
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end('forbidden'); return; }

  if (!session && !isGateOpen(rel)) {
    res.writeHead(302, {
      location: '/login.html?next=' + encodeURIComponent(pathname || '/'),
      'cache-control': 'no-store',
    });
    res.end();
    return;
  }

  // Signed in, but this page belongs to another role: send them to their own
  // rather than show a page that will refuse its data and read as broken.
  const needs = pageRoleFor(rel);
  if (session && needs && !roleFitsPage(session.role, needs)) {
    const home = ROLE_HOME[session.role] || ROLE_HOME.user;
    res.writeHead(302, {
      location: home.href + '?wrongrole=' + encodeURIComponent(session.role),
      'cache-control': 'no-store',
    });
    res.end();
    return;
  }

  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    let body = await readFile(file);
    // An HTML page that left a <!--nav--> marker gets the bar for this role,
    // written here so the right links are in the first paint.
    if (extname(file).toLowerCase() === '.html') {
      const text = body.toString('utf8');
      if (text.indexOf(NAV_MARKER) !== -1) {
        body = Buffer.from(withNav(text, session ? session.role : null, rel,
          session ? session.name : null), 'utf8');
      }
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found: ' + rel);
  }
}

/* ── http ────────────────────────────────────────────────────────────────── */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;
  const session = readSession(req.headers.cookie);

  if (p === '/status') {
    // The operator view is no longer open to the world. Before this, anyone
    // who reached the port saw every number and every partner IP.
    if (!session) {
      return json(res, 401, {
        error: 'a session is required to read the operator panel',
        hint: 'POST /session with {role:"admin", key:"…"}',
      });
    }
    if (!isAdminish(session.role)) {
      return json(res, 403, {
        error: 'this panel is for the admin role; you are ' + session.role,
      });
    }
    return json(res, 200, Object.assign(statusPayload(req), { viewer: session.role }));
  }

  // The public half: what a partner page may know about itself, no operator data.
  if (p === '/status/self') {
    if (!session) return json(res, 401, { error: 'no session' });
    return json(res, 200, {
      ok: true,
      role: session.role,
      port: PORT,
      socket: '/minter/ws',
      pool: { target: TARGET, lowwater: LOWWATER },
      authMode: 'keyed roles: partner, admin and superadmin need a key, user is open',
    });
  }

  if (p === '/session' && req.method === 'POST') {
    const body = await readBody(req);
    const role = String((body && body.role) || '').toLowerCase();
    if (!ROLES.has(role)) return json(res, 400, { error: 'role must be user, partner, admin or superadmin' });

    // A privileged role needs its key. This is the fix for "anyone can be
    // admin": the role is no longer whatever the caller types.
    const named = String((body && body.name) || '').trim();
    const owner = named && state.people.get(named);
    let identity = null;
    if (owner && owner.role === role && checkKey(role, body && body.key)
      && credentialMatches(owner, body && body.key)) {
      // The person's own key: the session carries their name.
      identity = owner.name;
      owner.uses++;
    } else if (role === 'superadmin' && (!named || named === SUPERADMIN_NAME)
      && checkKey(role, body && body.key)) {
      // The seeded superadmin has a name even when the caller sends none, so
      // its sessions, mint sockets and donations are attributable like a
      // person's rather than being an anonymous admin.
      identity = SUPERADMIN_NAME;
      const seed = state.people.get(SUPERADMIN_NAME);
      if (seed) seed.uses++;
    } else if (!checkKey(role, body && body.key)) {
      log('refused ' + role + ' session: ' + (needsKey(role) ? 'wrong or missing key' : 'not allowed'));
      return json(res, 401, {
        error: needsKey(role)
          ? 'this role needs a key; send {role, key, name?}'
          : 'this role cannot be granted',
        role,
      });
    } else if (named && !owner) {
      return json(res, 400, { error: 'unknown person: ' + named + ' (the hub knows: ' + [...state.people.keys()].join(', ') + ')' });
    } else if (owner && owner.role !== role) {
      return json(res, 400, { error: named + ' holds the ' + owner.role + ' key, not ' + role });
    }

    const cookie = issueSession(role, identity);
    // httpOnly: the page does not need to read it, and scripts shouldn't.
    // SameSite=Lax: fine for a same-origin socket handshake.
    res.setHeader('set-cookie',
      'glm_sid=' + encodeURIComponent(cookie) + '; HttpOnly; SameSite=Lax; Path=/; Max-Age='
        + Math.max(60, Math.floor(SESSION_TTL_MS / 1000)));
    log('session issued for role ' + role
      + (identity ? ' as person ' + identity : '')
      + (needsKey(role) ? ' (key accepted)' : ' (open role)'));
    return json(res, 200, {
      ok: true,
      role,
      name: identity,
      verified: needsKey(role) ? 'key' : 'none',
      note: identity
        ? 'the role was granted to ' + identity + ' by their key in the people registry'
        : needsKey(role)
          ? 'the role was granted by its key; no person claimed it (send name to sign as a person)'
          : 'no key needed for this role: lending an IP grants no access',
    });
  }

  if (p === '/session' && req.method === 'GET') {
    return json(res, 200, session
      ? { ok: true, role: session.role, name: session.name || null }
      : { ok: false, role: null, name: null });
  }

  /* ── deployment config for the browser ────────────────────────────────────
   * The minter page and glm-client.js read this instead of carrying baked-in
   * constants. It is deliberately public: these are the values a browser must
   * know to run the widget at all, and none of them is a secret (the verify
   * exchange itself stays server-side and admin-gated). A deploy that leaves
   * every variable unset answers with the captured original values, so the
   * page behaves exactly as recorded. */
  if (p === '/config' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      captcha: {
        scene: CONFIG.captcha.scene,
        prefix: CONFIG.captcha.prefix,
        region: CONFIG.captcha.region,
        lang: CONFIG.captcha.lang,
        sdkUrl: CONFIG.captcha.sdkUrl,
        // The appkey is public by design (the widget ships it to every browser).
        appkey: CONFIG.captcha.appkey,
      },
      upstream: {
        feVersion: CONFIG.upstream.feVersion,
        region: CONFIG.upstream.region,
        sources: Object.fromEntries(Object.entries(CONFIG.upstream.sources)
          .map(([k, v]) => [k, { origin: v.origin, path: v.path, region: v.region }])),
      },
      models: { bases: BASE_MODELS },
      // Where this hub is reachable. Derived from the request, so a page or a
      // client can build its own URLs without a hardcoded localhost.
      deploy: deploymentInfo(req),
      source: 'env with captured defaults; unset variables fall back to the original values',
    });
  }

  /* ── partner donations: the endpoint partner.html's form posts to ─────────
   * A donation is a device token or a signed-in session pasted by a partner.
   * The hub stores only what it must: the kind, the person who sent it, a
   * SHA-256 fingerprint (so the same value can be recognised and counted
   * without keeping it), when, and a verification status. The value itself is
   * never written, logged or echoed back — the same rule the page promises.
   *
   * Statuses: "unverified" until someone proves it, then "valid"/"invalid"
   * from a real Aliyun exchange (POST /captcha/verify carries the donated
   * value to Aliyun and records what it answered). Nothing invents a result. */
  if (p === '/tokens' && req.method === 'POST') {
    if (!session) {
      return json(res, 401, { error: 'a session is required to donate; sign in first' });
    }
    if (session.role !== 'partner' && !isAdminish(session.role)) {
      return json(res, 403, { error: 'donating is for the partner or admin role; you are ' + session.role });
    }
    const body = await readBody(req);
    if (!body || typeof body !== 'object') return json(res, 400, { error: 'bad json' });
    const kind = String(body.kind || '').toLowerCase();
    const value = String(body.value || '');
    if (kind !== 'token' && kind !== 'session') {
      return json(res, 400, { error: 'kind must be token or session' });
    }
    if (!value.trim()) return json(res, 400, { error: 'value is empty' });
    if (value.length > 8192) return json(res, 413, { error: 'value is too long' });

    const fp = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
    const existing = state.donated.find((d) => d.fp === fp);
    if (existing) {
      return json(res, 200, { ok: true, duplicate: true, fp, donated: state.donated.length, status: existing.status });
    }

    // Checked after dedupe: a repeat costs a scan and never reaches Aliyun, so
    // it must not be counted against the limit. Everything past this point does
    // cost one outbound exchange.
    const who = chatKeyOf(req, session);
    const verifying = state.verifying.get(who) || 0;
    if (verifying >= DONATE_CONCURRENCY) {
      state.donateThrottled++;
      const secs = String(DONATE_RETRY_AFTER_S);
      res.setHeader('retry-after', secs);
      return json(res, 429, {
        error: {
          message: 'already verifying ' + verifying + ' of this caller\'s donation(s): '
            + DONATE_CONCURRENCY + ' at a time is the limit; try again in ' + secs + 's',
          type: 'rate_limit_error',
          limit: DONATE_CONCURRENCY,
          retry_after_seconds: Number(secs),
        },
      });
    }
    state.verifying.set(who, verifying + 1);

    const donation = {
      kind,
      fp,
      person: session.name || null,
      role: session.role,
      status: 'verifying',
      at: Date.now(),
      checkedAt: null,
      detail: '',
    };
    state.donated.push(donation);
    // Same ceiling as state.captchaChecks: /tokens?all=1 serialises this whole
    // array, so it must not grow for the life of the process.
    if (state.donated.length > 200) state.donated.shift();

    // Verify straight away, off the request path, so a slow Aliyun answer never
    // holds the partner's form open. The value is captured here and dropped the
    // moment the exchange ends — it is never stored on the donation.
    verifyDonation(donation, value).then(() => {
      log('donation ' + kind + ' fp=' + fp + ' -> ' + donation.status
        + (donation.detail ? ' (' + donation.detail + ')' : ''));
    }).catch(() => {
      donation.status = 'unverified';
      donation.detail = 'auto-verification failed unexpectedly';
      donation.checkedAt = Date.now();
    }).finally(() => {
      // The slot is held for the exchange, not for the request: the response
      // went out before this promise settled.
      const left = (state.verifying.get(who) || 1) - 1;
      if (left <= 0) state.verifying.delete(who);
      else state.verifying.set(who, left);
    });

    log('donation recorded: ' + kind + ' fp=' + fp
      + ' from ' + (session.name || session.role)
      + ' status=verifying (' + state.donated.length + ' held)');
    return json(res, 200, {
      ok: true,
      fp,
      donated: state.donated.length,
      status: 'verifying',
      note: 'accepted; verification runs now — GET /tokens?mine=1 shows the settled status',
    });
  }

  // The partner-facing half: counts and kinds only, never the values.
  // A ?mine=1 partner sees their own donations' statuses.
  if (p === '/tokens' && req.method === 'GET') {
    if (!session || (session.role !== 'partner' && !isAdminish(session.role))) {
      return json(res, 401, { error: 'a partner or admin session is required' });
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.searchParams.get('mine') === '1') {
      const mine = state.donated
        .filter((d) => session.name && d.person === session.name)
        .map((d) => ({ kind: d.kind, fp: d.fp, status: d.status, at: d.at, checkedAt: d.checkedAt }));
      return json(res, 200, { ok: true, mine });
    }
    if (url.searchParams.get('all') === '1') {
      // Admin-only listing: fingerprints and statuses, still never the values.
      if (!isAdminish(session.role)) {
        return json(res, 403, { error: 'the full list is admin-only' });
      }
      return json(res, 200, {
        ok: true,
        donations: state.donated.map((d) => ({
          kind: d.kind, fp: d.fp, person: d.person, role: d.role,
          status: d.status, at: d.at, checkedAt: d.checkedAt,
        })),
      });
    }
    return json(res, 200, {
      ok: true,
      held: state.donated.length,
      tokens: state.donated.filter((d) => d.kind === 'token').length,
      sessions: state.donated.filter((d) => d.kind === 'session').length,
      valid: state.donated.filter((d) => d.status === 'valid').length,
      invalid: state.donated.filter((d) => d.status === 'invalid').length,
      verifying: state.donated.filter((d) => d.status === 'verifying').length,
      unverified: state.donated.filter((d) => d.status === 'unverified').length,
      note: 'a donation is verified on arrival; statuses come from real Aliyun exchanges, unverified means not proven',
    });
  }

  /* ── captcha verification: prove a minted param or a donation ────────────
   * Admin-only. `value` is a donated value's fingerprint OR a raw captcha
   * param; `param` sends a raw param straight to Aliyun. The answer is
   * recorded either way — this is the check the hub previously could not do. */
  if (p === '/captcha/verify' && req.method === 'POST') {
    if (!session || !isAdminish(session.role)) {
      return json(res, session ? 403 : 401, {
        error: 'captcha verification is admin-only' + (session ? '' : '; sign in first'),
      });
    }
    const body = await readBody(req);
    if (!body || typeof body !== 'object') return json(res, 400, { error: 'bad json' });
    const fp = String(body.fp || '');
    const raw = String(body.param || '');
    const scene = String(body.scene || '') || null;

    let target = null;
    let param = raw;
    if (fp && !raw) {
      target = state.donated.find((d) => d.fp === fp);
      if (!target) return json(res, 404, { error: 'no donation with fingerprint ' + fp });
      param = body.value || null;
      if (param == null) {
        // The donation's raw value was never kept, so a donated value can only
        // be exchanged if the caller re-supplies it alongside the fingerprint.
        return json(res, 400, {
          error: 'the hub keeps only the fingerprint; send {fp, value} (the value again) or {param} (a captcha param)',
        });
      }
    }
    const record = {
      at: Date.now(),
      by: session.name || session.role,
      target: target ? ('donation ' + fp) : 'raw param',
    };
    if (!param) {
      return json(res, 400, { error: 'nothing to verify: send {param} or {fp, value}' });
    }
    const answer = await verifyCaptchaParam(param, scene);
    record.status = answer.status;
    record.detail = answer.detail;
    record.scene = answer.scene;
    if (target) {
      target.status = answer.status === 'unverified' ? 'unverified' : answer.status;
      target.checkedAt = answer.checkedAt;
    }
    state.captchaChecks.push(record);
    if (state.captchaChecks.length > 200) state.captchaChecks.shift();
    log('captcha verify by ' + record.by + ': ' + record.target + ' -> ' + answer.status
      + (answer.detail ? ' (' + answer.detail + ')' : ''));
    return json(res, 200, { ok: true, ...answer, target: record.target });
  }

  /* ── people: the per-person directory ──────────────────────────────────── */
  if (p === '/people' && req.method === 'GET') {
    if (!session || !isAdminish(session.role)) {
      return json(res, session ? 403 : 401, { error: 'the people directory is admin-only' });
    }
    return json(res, 200, {
      ok: true,
      people: [...state.people.values()].map((o) => ({
        name: o.name,
        role: o.role,
        at: o.at,
        uses: o.uses,
        donations: state.donated.filter((d) => d.person === o.name).length,
        pinned: pinnedPerson(o),
        source: sourceOf(o),
        note: 'the key itself is never listed here',
      })),
      storage: STATE_FILE
        ? { file: STATE_FILE, keys: 'hashed (scrypt + per-person salt), never written as supplied', note: 'the directory is written on every change and reloaded on start' }
        : { file: null, keys: 'not written at all — no state file is set', note: 'set GLM_STATE_FILE to keep the directory across restarts' },
    });
  }

  /* ── directory administration: create, revoke, rotate ────────────────────
   * Admin-only, superadmin for creating people (a partner should not be able
   * to mint themselves an admin). Revocation takes effect on the next request
   * and drops the person's live sessions and sockets; rotation returns the new
   * key exactly once, and is never listed afterwards. */
  if (p === '/people' && req.method === 'POST') {
    if (!session || session.role !== 'superadmin') {
      return json(res, session ? 403 : 401, {
        error: 'creating people is superadmin-only; an admin may revoke and rotate',
      });
    }
    const body = await readBody(req);
    if (!body || typeof body !== 'object') return json(res, 400, { error: 'bad json' });
    const name = String(body.name || '').trim();
    const role = String(body.role || '').toLowerCase();
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(name)) {
      return json(res, 400, { error: 'name must be 1-40 characters of letters, digits, dot, dash or underscore' });
    }
    if (!ROLES.has(role)) return json(res, 400, { error: 'role must be user, partner, admin or superadmin' });
    if (state.people.has(name)) return json(res, 409, { error: 'a person named ' + name + ' already exists' });
    const key = String(body.key || '').trim() || ('glm-' + role + '-' + randomBytes(12).toString('hex'));
    if (key.length < 8) return json(res, 400, { error: 'a supplied key must be at least 8 characters' });
    // Only the hash is kept; this response is the one and only sight of the key.
    state.people.set(name, { name, role, ...makeCredential(key), at: Date.now(), uses: 0 });
    savePeople();
    log('created person ' + name + ' (' + role + ')');
    return json(res, 201, { ok: true, name, role, key, note: 'this is the only time the key is returned' });
  }

  if (p === '/people/revoke' && req.method === 'POST') {
    if (!session || !isAdminish(session.role)) {
      return json(res, session ? 403 : 401, { error: 'revoking a person is admin-only' });
    }
    const body = await readBody(req);
    const name = String((body && body.name) || '').trim();
    if (!name) return json(res, 400, { error: 'send {name}' });
    // An admin may not revoke a superadmin, or the roles would flatten.
    const target = state.people.get(name);
    if (target && target.role === 'superadmin' && session.role !== 'superadmin') {
      return json(res, 403, { error: 'only a superadmin may revoke a superadmin' });
    }
    const out = revokePerson(name);
    return json(res, out.ok ? 200 : 400, out);
  }

  if (p === '/people/rotate' && req.method === 'POST') {
    if (!session || !isAdminish(session.role)) {
      return json(res, session ? 403 : 401, { error: 'rotating a key is admin-only' });
    }
    const body = await readBody(req);
    const name = String((body && body.name) || '').trim();
    if (!name) return json(res, 400, { error: 'send {name}' });
    const target = state.people.get(name);
    if (target && target.role === 'superadmin' && session.role !== 'superadmin') {
      return json(res, 403, { error: 'only a superadmin may rotate a superadmin key' });
    }
    const out = rotatePerson(name);
    return json(res, out.ok ? 200 : 400, out);
  }

  if (p === '/features' && req.method === 'POST') {
    // These toggles are defaults applied to every chat request, so they are
    // server-wide state: an anonymous write would let anyone change what every
    // client asks the upstream for. The panel posts here, so admin is enough.
    if (!session || !isAdminish(session.role)) {
      return json(res, session ? 403 : 401, {
        error: session
          ? 'changing feature defaults needs an admin session; you are ' + session.role
          : 'changing feature defaults needs an admin session; sign in first',
      });
    }
    const body = await readBody(req);
    if (!body || typeof body !== 'object') return json(res, 400, { error: 'bad json' });
    const applied = {};
    for (const [k, v] of Object.entries(body)) {
      if (k in state.features) { state.features[k] = !!v; applied[k] = !!v; }
    }
    log('features -> ' + JSON.stringify(applied));
    return json(res, 200, { ok: true, features: state.features });
  }

  if (p === '/admin/session/clear' && req.method === 'POST') {
    // This closes every partner socket, so an unauthenticated caller could
    // disconnect the whole fleet with one request.
    if (!session || !isAdminish(session.role)) {
      return json(res, session ? 403 : 401, {
        error: session
          ? 'dropping partner sessions needs an admin session; you are ' + session.role
          : 'dropping partner sessions needs an admin session; sign in first',
      });
    }
    // Drop partners, not the caller's own role: dropping every session would
    // log the operator out of the page they just clicked.
    let dropped = 0;
    for (const partner of state.partners.values()) {
      if (partner.socket) { partner.socket.close(1001, 'dropped by admin'); dropped++; }
    }
    log('admin dropped ' + dropped + ' partner session(s)');
    return json(res, 200, { ok: true, dropped });
  }

  if (p === '/v1/models' && req.method === 'GET') {
    return json(res, 200, {
      object: 'list',
      data: CATALOG.map((m) => ({
        id: m.id,
        object: 'model',
        owned_by: 'glm2api',
        meta: {
          source: m.source,
          base: m.base,
          features: m.features,
          declared_only: true,
        },
      })),
    });
  }

  if (p === '/v1/chat/completions' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: { message: 'bad json', type: 'invalid_request_error' } });
    const resolved = resolveModel(body.model);
    if (!resolved) {
      return json(res, 400, {
        error: {
          message: 'unknown model. The catalog is <source>/<base>[-suffix] — e.g. z.ai/glm-5.3, '
            + 'cn/glm-5.3-think — with suffixes -think, -search, -deepresearch. GET /v1/models lists it.',
          type: 'invalid_request_error',
          requested_model: body.model || null,
        },
      });
    }
    const { entry, declared } = resolved;

    // No upstream configured: refuse honestly instead of guessing.
    if (!UPSTREAM.url) {
      return json(res, 501, {
        error: {
          message: 'no upstream: set GLM_UPSTREAM (and optionally GLM_UPSTREAM_KEY) to forward chat. '
            + 'The model id was resolved fine — ' + entry.id + ' — there is just nowhere to send it.',
          type: 'not_implemented',
          requested_model: body.model || null,
          resolved_model: entry.id,
        },
      });
    }

    // Forward. Suffix features are declared metadata; the hub rewrites the
    // model id to the source's plain base name and lets the flags ride in the
    // body, since what each suffix maps to on the wire is upstream policy.
    const origin = SOURCES[entry.source];
    // GLM_UPSTREAM redirects the destination: a deploy pointing at its own
    // z.ai-compatible gateway, or a test pointing at a local stub. The source
    // in the model id still picks the path, so `cn/` and `z.ai/` keep their
    // own endpoints; with GLM_UPSTREAM unset the captured origins are used.
    const dest = UPSTREAM.url
      ? { origin: UPSTREAM.url.replace(/\/+$/, ''), path: origin.path, region: origin.region }
      : origin;

    // Limit before spending: a refused request must not burn a pool entry, and
    // the slot is taken before the upstream call rather than after it.
    const who = chatKeyOf(req, session);
    const slot = takeChatSlot(who);
    if (!slot.ok) {
      state.chat.throttled++;
      const secs = String(Math.max(1, slot.retryAfter));
      res.setHeader('retry-after', secs);
      return json(res, 429, {
        error: {
          message: (slot.why === 'busy'
            ? 'too many requests in flight: one caller may hold ' + CHAT_CONCURRENCY + ' at once'
            : 'still cooling down after the limit was hit')
            + '; try again in ' + secs + 's',
          type: 'rate_limit_error',
          limit: CHAT_CONCURRENCY,
          retry_after_seconds: Number(secs),
        },
      });
    }

    // Spend the pool: take the oldest minted param and attach it as the
    // captcha_verify_param the upstream requires. This is the whole reason the
    // minter page exists — a pool nothing spends is a counter, not a resource.
    const spent = consumeToken();
    const prompt = promptOf(body.messages);
    const payload = {
      model: entry.base,
      chat_id: 'chat-' + randomUuid(),
      messages: body.messages,
      signature_prompt: prompt,
      stream: Boolean(body.stream),
    };
    if (spent && spent.param) payload.captcha_verify_param = spent.param;
    // Feature flags in the shape the reference projects send. Two sources, and
    // the order matters: the model suffix says what THIS request wants, the
    // panel's toggles are defaults for every request, and a suffix turns a
    // feature on but never off - the same additive rule the reference bridge
    // uses. So `-think` is a way to ask for thinking even when the default is
    // off, which is what makes the suffix worth having.
    // The two names differ on purpose: the suffix calls it `thinking`, the
    // wire and the panel call it `enable_thinking`. Passing both is what stops
    // a default from being looked up under a key that never exists.
    const wants = (feature, key) => declared.includes(feature) || state.features[key] === true;
    const thinking = wants('thinking', 'enable_thinking');
    const search = wants('web_search', 'web_search');
    payload.features = {
      image_generation: false,
      web_search: search,
      auto_web_search: search,
      preview_mode: state.features.preview_mode === true,
      flags: [],
      enable_thinking: thinking,
    };
    if (declared.includes('deep_research')) payload.deep_research = true;
    for (const k of ['temperature', 'top_p', 'max_tokens']) {
      if (body[k] !== undefined) payload[k] = body[k];
    }
    const headers = { 'content-type': 'application/json' };
    if (UPSTREAM.key) headers.authorization = 'Bearer ' + UPSTREAM.key;
    headers['x-fe-version'] = FE_VERSION;
    headers['x-region'] = dest.region;
    // The signature covers the prompt, so it must be computed from the same
    // prompt the body carries.
    headers['x-signature'] = signZai(prompt, UPSTREAM.key);

    state.chat.requests++;
    state.chat.lastModel = entry.id;
    if (spent) state.chat.poolSpent++;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), UPSTREAM.timeoutMs);
      const up = await fetch(dest.origin + dest.path, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      state.chat.lastStatus = up.status;
      state.chat.lastAt = Date.now();
      const text = await up.text();
      // Rejected because of the credential or the captcha, not because of the
      // question: put the entry back at the head so it is not silently burned.
      if (spent && (up.status === 401 || up.status === 403 || up.status === 429)) {
        state.tokens.unshift(spent);
        state.consumed = Math.max(0, state.consumed - 1);
        // The entry did not get spent, so the "spent" counter must not keep
        // it. Without this the panel's number only ever climbs.
        state.chat.poolSpent = Math.max(0, state.chat.poolSpent - 1);
        log('chat -> ' + entry.id + ' HTTP ' + up.status + '; pool entry returned unspent');
      } else if (spent) {
        log('chat -> ' + entry.id + ' spent a pool entry (' + state.tokens.length + ' left)');
      } else {
        log('chat -> ' + entry.id + ' with an empty pool (no captcha param attached)');
      }
      res.writeHead(up.status, {
        'content-type': up.headers.get('content-type') || 'application/json',
        'x-glm-pool': spent ? 'spent' : 'empty',
      });
      res.end(text);
      if (up.ok) { state.chat.ok++; log('chat -> ' + entry.id + ' ok'); }
      else { state.chat.failed++; log('chat -> ' + entry.id + ' HTTP ' + up.status); }
      // The response is already sent: returning falls through to the static
      // handler and throws ERR_HTTP_HEADERS_SENT. Every other route returns.
      refillPool();
      return;
    } catch (e) {
      // The entry never reached the upstream, so it is still good.
      if (spent) {
        state.tokens.unshift(spent);
        state.consumed = Math.max(0, state.consumed - 1);
        state.chat.poolSpent = Math.max(0, state.chat.poolSpent - 1);
      }
      state.chat.failed++;
      state.chat.lastStatus = 'error';
      state.chat.lastAt = Date.now();
      return json(res, 502, {
        error: {
          message: 'upstream unreachable: ' + (e && e.name === 'AbortError'
            ? 'timed out after ' + UPSTREAM.timeoutMs + 'ms'
            : 'could not reach ' + dest.origin),
          type: 'bad_gateway',
          resolved_model: entry.id,
        },
      });
    } finally {
      // Every admitted request gives its slot back, on success, on refusal from
      // upstream, and on a throw — otherwise four failures would lock a caller
      // out until the process restarted.
      releaseChatSlot(who);
    }
  }

  if (p === '/minter/ws') {
    // Only reachable through the upgrade handler; a plain GET explains itself.
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8', upgrade: 'websocket' });
    return res.end('this path speaks WebSocket');
  }

  return serveStatic(req, res, p, session);
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/minter/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  // Who is asking? A same-origin session cookie rides along with the upgrade,
  // so a browser that signed in at login.html is recognised here with no
  // extra handshake. Without one, an anonymous socket must not be handed work.
  const session = readSession(req.headers.cookie);
  const authMode = String(process.env.GLM_WS_AUTH || 'required').toLowerCase();
  if (authMode !== 'open' && !session) {
    log('refused a mint socket: no session (set GLM_WS_AUTH=open to allow anonymous)');
    socket.write(
      'HTTP/1.1 401 Unauthorized\r\n' +
      'content-type: text/plain; charset=utf-8\r\n\r\n' +
      'a session is required to receive mint work: sign in first, or set GLM_WS_AUTH=open\n'
    );
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  onMinterSocket(attachSocket(socket), req, session);
});

server.listen(PORT, HOST, () => {
  log('hub listening on http://' + HOST + ':' + PORT + '/');
  log('  minter socket  ws://' + HOST + ':' + PORT + '/minter/ws');
  log('  admin status   http://' + HOST + ':' + PORT + '/status');
  log('  token target   ' + TARGET + ' (low water ' + LOWWATER + ', ttl '
    + Math.round(TOKEN_TTL_MS / 1000) + 's, sweep every ' + Math.round(SWEEP_MS / 1000) + 's)');
  log('sessions: roles need their key (partner, admin, superadmin), signed with an '
    + (process.env.SESSION_SECRET ? 'operator-supplied' : 'ephemeral') + ' key');

  // The seeded superadmin: one account above admin, ready at startup.
  log('  superadmin     "' + SUPERADMIN_NAME + '" seeded (' + SUPERADMIN_SOURCE + ')');
  if (SUPERADMIN_SEED_KEY || GENERATED.has('superadmin')) {
    log('  superadmin key (printed once): ' + SUPERADMIN_KEY);
    log(STATE_FILE
      ? '  keep it: only its hash is stored in ' + STATE_FILE + ', which carries the account across restarts'
      : '  keep it: set GLM_STATE_FILE=<path> to keep the account across restarts, or GLM_SUPERADMIN=<key> to pin it');
  } else if (SUPERADMIN_SOURCE === 'the state file') {
    log('  superadmin key: not shown again — its hash is in ' + STATE_FILE
      + '; use the key printed when the account was seeded');
  }

  // Roles that carry privilege need a key. If none was supplied, one was
  // generated - print it once, loudly, or the operator is locked out. The
  // superadmin's own key is printed above with its source, so it is skipped
  // here; printing it twice used to show two different keys for one account.
  for (const role of KEY_ROLES) {
    if (role === 'superadmin') continue;
    if (GENERATED.has(role)) {
      log('  ' + role + ' key (generated this run): ' + GENERATED.get(role));
    } else {
      log('  ' + role + ' key: from GLM_KEYS');
    }
  }
  // Only the roles printed above count: a generated superadmin key that was
  // overridden by GLM_SUPERADMIN is not a key anyone still needs to keep.
  if (KEY_ROLES.some((r) => r !== 'superadmin' && GENERATED.has(r))) {
    log('  set GLM_KEYS=partner:<key>,admin:<key> to keep a key across restarts');
  }
  for (const o of state.people.values()) {
    if (o.name === SUPERADMIN_NAME) continue;   // reported above with its source
    log('  person ' + o.name + ' holds the ' + o.role + ' key ('
      + (pinnedPerson(o) ? 'GLM_PEOPLE' : 'the directory') + ')');
  }
  if (state.people.size <= 1) {
    log('  no people registry: set GLM_PEOPLE=alice=partner:<key>,bob=admin:<key> for per-person identity, '
      + 'or create them from the admin panel as a superadmin');
  }
  if (STATE_FILE) {
    log('  people directory: ' + STATE_FILE
      + ' (written on change; a revocation survives a restart)');
  } else {
    log('  people directory: memory only — set GLM_STATE_FILE=<path> to keep it across restarts');
  }
  if (UPSTREAM.url) {
    log('  upstream: ' + UPSTREAM.url + (UPSTREAM.key ? ' (with a key)' : ' (no key)'));
  } else {
    log('  no upstream: /v1/chat/completions answers 501 (set GLM_UPSTREAM to forward)');
  }
  log('  chat limit: ' + CHAT_CONCURRENCY + ' in flight per caller, then a '
    + Math.round(CHAT_COOLDOWN_MS / 1000) + 's wait (429 + retry-after)');
  log('  donation limit: ' + DONATE_CONCURRENCY + ' Aliyun exchange(s) in flight per caller');
  if (String(process.env.GLM_WS_AUTH || 'required').toLowerCase() === 'open') {
    log('  WARNING: GLM_WS_AUTH=open — anonymous sockets may receive mint work');
  }
});

/* A clean exit matters because the sockets are long-lived. */
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('shutting down (' + state.partners.size + ' partner(s) connected)');
    for (const p of state.partners.values()) if (p.socket) p.socket.close(1001, 'server stopping');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
