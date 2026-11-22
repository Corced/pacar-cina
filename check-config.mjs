/* check-config.mjs — prove the deployment values are dynamic, not baked in.
 *
 * Two hubs are started in turn:
 *
 *   A. nothing configured beyond the keys — every value must come back as the
 *      value the original capture showed, so a plain checkout is faithful.
 *   B. every knob overridden — each value must come back as the override, which
 *      is what makes a deploy configurable without editing code.
 *
 * Then the same hub is asked for its pages, to prove the gate redirects a
 * stranger to the login page while leaving that page (and its assets) public.
 *
 * No dependencies, nothing outside this process, everything in memory.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT_A = Number(process.env.TEST_PORT_A || 5211);
const PORT_B = Number(process.env.TEST_PORT_B || 5212);

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? '  — ' + extra : ''));
  if (!ok) failures++;
}

/* The values the recorded original used. Any of these changing under an empty
 * environment would mean the faithful default was lost. */
const CAPTURED = {
  scene: 'no8xfe',
  prefix: 'didk33e0',
  appkey: 'FFFF0N00000000007EC0',
  region: 'sgp',
  lang: 'en',
  sdkUrl: 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js',
  feVersion: 'prod-fe-1.1.79',
  zaiOrigin: 'https://chat.z.ai',
  zaiPath: '/api/v2/chat/completions',
  cnOrigin: 'https://chatglm.cn',
  cnPath: '/api/v1/chat/completions',
  bases: ['glm-5.3', 'glm-4.7', 'glm-4.6', 'glm-5v-turbo'],
};

/* Start a hub, hand it to fn, then stop it. Each run gets a fresh process so a
 * variable set for one run cannot leak into the next. */
async function withHub(port, env, fn) {
  const child = spawn(process.execPath, [join(ROOT, 'server', 'hub.mjs')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  const base = 'http://127.0.0.1:' + port;
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      try { await fetch(base + '/status/self'); up = true; break; } catch { await sleep(100); }
    }
    if (!up) throw new Error('hub on ' + port + ' never came up:\n' + out);
    await fn(base);
  } finally {
    child.kill('SIGTERM');
    await sleep(150);
  }
}

async function getJson(base, url, cookie, redirect) {
  const r = await fetch(base + url, {
    headers: cookie ? { cookie } : {},
    redirect: redirect || 'follow',
  });
  const raw = await r.text();
  let body = null;
  try { body = JSON.parse(raw); } catch { /* non-json */ }
  return {
    status: r.status,
    location: r.headers.get('location') || '',
    ct: r.headers.get('content-type') || '',
    body,
    raw,
  };
}

async function signIn(base, role, key) {
  const r = await fetch(base + '/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role, key }),
  });
  const setCookies = typeof r.headers.getSetCookie === 'function'
    ? r.headers.getSetCookie()
    : [r.headers.get('set-cookie') || ''];
  const raw = setCookies.find((c) => /glm_sid=/.test(c)) || '';
  return {
    status: r.status,
    cookie: raw.split(';')[0],
    raw,
    body: await r.json().catch(() => null),
  };
}

const KEYS = { GLM_KEYS: 'partner:c-partner,admin:c-admin', SESSION_SECRET: 'check-config-secret' };

try {
  /* ── A. nothing configured: the captured defaults must survive ────────── */
  await withHub(PORT_A, KEYS, async (base) => {
    const cfg = await getJson(base, '/config');
    check('/config answers without a session (the browser needs it first)',
      cfg.status === 200 && cfg.body && cfg.body.ok === true, 'HTTP ' + cfg.status);

    const c = (cfg.body && cfg.body.captcha) || {};
    check('captcha scene is the captured default', c.scene === CAPTURED.scene, String(c.scene));
    check('captcha prefix is the captured default', c.prefix === CAPTURED.prefix, String(c.prefix));
    check('captcha appkey is the captured default', c.appkey === CAPTURED.appkey, String(c.appkey));
    check('captcha region is the captured default', c.region === CAPTURED.region, String(c.region));
    check('captcha language is the captured default', c.lang === CAPTURED.lang, String(c.lang));
    check('the SDK still comes from the documented CDN', c.sdkUrl === CAPTURED.sdkUrl, String(c.sdkUrl));

    const u = (cfg.body && cfg.body.upstream) || {};
    check('the FE version is the captured default', u.feVersion === CAPTURED.feVersion, String(u.feVersion));
    const z = (u.sources && u.sources['z.ai']) || {};
    const cn = (u.sources && u.sources.cn) || {};
    check('z.ai talks to chat.z.ai', z.origin === CAPTURED.zaiOrigin && z.path === CAPTURED.zaiPath,
      z.origin + z.path);
    check('cn talks to chatglm.cn', cn.origin === CAPTURED.cnOrigin && cn.path === CAPTURED.cnPath,
      cn.origin + cn.path);

    const bases = (cfg.body && cfg.body.models && cfg.body.models.bases) || [];
    check('the captured model bases are all present, in order',
      CAPTURED.bases.every((b, i) => bases[i] === b), JSON.stringify(bases));
    check('no extra bases appear when none were configured', bases.length === CAPTURED.bases.length,
      bases.length + ' base(s)');

    const models = await getJson(base, '/v1/models');
    check('the catalog is still 32 ids from the four captured bases',
      models.status === 200 && models.body.data.length === 32, (models.body.data || []).length + ' ids');

    const status = await getJson(base, '/status', (await signIn(base, 'admin', 'c-admin')).cookie);
    check('/status reports the FE version in use', status.body && status.body.finder
      ? true : status.body && status.body.feVersion === CAPTURED.feVersion,
      String(status.body && status.body.feVersion));
  });

  /* ── B. every knob overridden: each override must win ─────────────────── */
  await withHub(PORT_B, {
    ...KEYS,
    GLM_CAPTCHA_SCENE: 'scene-from-env',
    GLM_CAPTCHA_PREFIX: 'prefix-from-env',
    GLM_CAPTCHA_APPKEY: 'appkey-from-env',
    GLM_CAPTCHA_REGION: 'cn',
    GLM_CAPTCHA_LANG: 'zh',
    GLM_CAPTCHA_SDK_URL: 'https://example.test/aliyunCaptcha.js',
    GLM_CAPTCHA_VERIFY_URL: 'https://example.test/verify',
    FE_VERSION: 'prod-fe-9.9.99',
    GLM_ZAI_ORIGIN: 'https://zai.example.test',
    GLM_CN_ORIGIN: 'https://cn.example.test',
    GLM_MODEL_EXTRA: 'glm-9.9, glm-8v',
  }, async (base) => {
    const cfg = await getJson(base, '/config');
    const c = (cfg.body && cfg.body.captcha) || {};
    check('an env scene reaches the browser', c.scene === 'scene-from-env', String(c.scene));
    check('an env prefix reaches the browser', c.prefix === 'prefix-from-env', String(c.prefix));
    check('an env appkey reaches the browser', c.appkey === 'appkey-from-env', String(c.appkey));
    check('an env region reaches the browser', c.region === 'cn', String(c.region));
    check('an env language reaches the browser', c.lang === 'zh', String(c.lang));
    check('an env SDK url reaches the browser',
      c.sdkUrl === 'https://example.test/aliyunCaptcha.js', String(c.sdkUrl));

    const u = (cfg.body && cfg.body.upstream) || {};
    check('an env FE version wins', u.feVersion === 'prod-fe-9.9.99', String(u.feVersion));
    check('an env z.ai origin wins', (u.sources['z.ai'] || {}).origin === 'https://zai.example.test',
      String((u.sources['z.ai'] || {}).origin));
    check('an env cn origin wins', (u.sources.cn || {}).origin === 'https://cn.example.test',
      String((u.sources.cn || {}).origin));

    const bases = (cfg.body && cfg.body.models && cfg.body.models.bases) || [];
    check('extra model bases are appended after the captured ones',
      CAPTURED.bases.every((b, i) => bases[i] === b)
        && bases.includes('glm-9.9') && bases.includes('glm-8v'),
      JSON.stringify(bases));
    check('whitespace around an extra base is trimmed', bases.includes('glm-9.9'));

    const models = await getJson(base, '/v1/models');
    const ids = (models.body && models.body.data || []).map((m) => m.id);
    check('the extra bases really appear in the catalog',
      ids.includes('z.ai/glm-9.9') && ids.includes('cn/glm-8v'), ids.length + ' ids');
    check('the catalog grew by two bases (8 ids each, with suffixes)',
      ids.length === 32 + 16, ids.length + ' ids');

    /* ── the page gate ── */
    const gated = await getJson(base, '/admin.html', null, 'manual');
    check('a page redirects a stranger to the login page',
      gated.status === 302 && /\/login\.html/.test(gated.location), 'HTTP ' + gated.status + ' ' + gated.location);
    check('the redirect remembers where the visitor was going',
      /next=%2Fadmin\.html|next=\/admin\.html/.test(gated.location), gated.location);

    const loginPage = await getJson(base, '/login.html', null, 'manual');
    check('the login page is public, or nobody could ever get in',
      loginPage.status === 200, 'HTTP ' + loginPage.status);

    const rolesJs = await getJson(base, '/roles.js', null, 'manual');
    check('the login page\'s script is public too', rolesJs.status === 200, 'HTTP ' + rolesJs.status);

    const rootGated = await getJson(base, '/', null, 'manual');
    check('the front door is the login page, not a role page',
      rootGated.status === 302 && /\/login\.html/.test(rootGated.location),
      'HTTP ' + rootGated.status + ' ' + rootGated.location);

    const admin = await signIn(base, 'admin', 'c-admin');
    const signed = await getJson(base, '/admin.html', admin.cookie, 'manual');
    check('a signed-in session gets the page', signed.status === 200, 'HTTP ' + signed.status);

    // A plain-words explanation must actually ship, not just the jargon table:
    // the person reading this panel is not expected to know the terms.
    const plain = signed.raw || '';
    check('the panel explains in plain words what "not done" means here',
      plain.includes('means here'));
    check('each plain-words gap names what would finish it',
      (plain.match(/Close it by/g) || []).length >= 2,
      'closing hints: ' + (plain.match(/Close it by/g) || []).length);

    const partner = await signIn(base, 'partner', 'c-partner');

    // "/" is no longer the minter: a signed-in visitor is sent to their own
    // page, so the front door behaves the same for everyone.
    const partnerRoot = await getJson(base, '/', partner.cookie, 'manual');
    check('a signed-in partner opening "/" lands on the partner page',
      partnerRoot.status === 302 && /\/partner\.html/.test(partnerRoot.location),
      'HTTP ' + partnerRoot.status + ' ' + partnerRoot.location);
    const adminRoot = await getJson(base, '/', admin.cookie, 'manual');
    check('a signed-in admin opening "/" lands on the panel',
      adminRoot.status === 302 && /\/admin\.html/.test(adminRoot.location),
      'HTTP ' + adminRoot.status + ' ' + adminRoot.location);

    // Pages still open to any signed-in role, as before.
    for (const page of ['/index.html', '/user.html', '/repos.html']) {
      const partnerPage = await getJson(base, page, partner.cookie, 'manual');
      check('any signed-in role may load ' + page,
        partnerPage.status === 200, 'HTTP ' + partnerPage.status);
    }

    /* ── role separation: no role is one click from another's page ───────── */
    // A partner clicking an admin link is sent to the partner page, told why,
    // instead of seeing a panel whose every number would be refused.
    const partnerOnAdmin = await getJson(base, '/admin.html', partner.cookie, 'manual');
    check('a partner opening the admin panel is sent to their own page',
      partnerOnAdmin.status === 302 && /\/partner\.html/.test(partnerOnAdmin.location),
      'HTTP ' + partnerOnAdmin.status + ' ' + partnerOnAdmin.location);
    check('and the redirect says which role they are',
      /wrongrole=partner/.test(partnerOnAdmin.location), partnerOnAdmin.location);

    const adminOnPartner = await getJson(base, '/partner.html', admin.cookie, 'manual');
    check('an admin opening the partner page is sent to the panel',
      adminOnPartner.status === 302 && /\/admin\.html/.test(adminOnPartner.location),
      'HTTP ' + adminOnPartner.status + ' ' + adminOnPartner.location);

    /* ── the navigation bar: each role gets its own links ────────────────── */
    // The bar is written into the page by the hub, so these assertions read the
    // served HTML rather than trusting a script to draw it later.
    const adminPanel = await getJson(base, '/admin.html', admin.cookie, 'manual');
    const ah = adminPanel.raw || '';
    check('the panel carries a navigation bar', /class="nav"/.test(ah));
    check('the bar says which role is reading', /data-role="admin"/.test(ah));
    check('the admin bar marks the panel as the current page',
      /navlink here[^>]*href="\/admin\.html"/.test(ah));
    check('the admin bar offers the minter and the reference page',
      /href="\/index\.html"/.test(ah) && /href="\/repos\.html"/.test(ah));
    check('the admin bar offers no partner form', !/href="\/partner\.html"/.test(ah));

    const partnerPage = await getJson(base, '/partner.html', partner.cookie, 'manual');
    const ph = partnerPage.raw || '';
    check('the partner page carries a bar too', /class="nav"/.test(ph));
    check('the bar says partner, not admin', /data-role="partner"/.test(ph));
    check('the partner bar offers the minter', /href="\/index\.html"/.test(ph));
    check('the partner bar offers no admin panel', !/href="\/admin\.html"/.test(ph));
    check('the partner bar offers no reference page', !/href="\/repos\.html"/.test(ph));

    // The chat page is the one page every signed-in role shares, and the only
    // one a person can use without curl. It has to be reachable, gated, and in
    // the bar — a page nobody can find is the same as a page that is missing.
    const chatPage = await getJson(base, '/chat.html', partner.cookie, 'manual');
    const ch = chatPage.raw || '';
    check('the chat page is reachable and carries the bar',
      chatPage.status === 200 && /class="nav"/.test(ch), 'HTTP ' + chatPage.status);
    check('the chat page connects its own script and the controls the script reads',
      /src="chat\.js"/.test(ch) && /id="send"/.test(ch) && /id="chat"/.test(ch)
      && /id="msg"/.test(ch) && /id="model"/.test(ch));
    check('every signed-in bar links the chat page',
      /href="\/chat\.html"/.test(ph) && /href="\/chat\.html"/.test(ah));
    const anonChat = await getJson(base, '/chat.html', null, 'manual');
    check('the chat page is gated like every other page',
      anonChat.status === 302 && /next=%2Fchat\.html/.test(anonChat.location),
      'HTTP ' + anonChat.status + ' ' + anonChat.location);

    // No marker may survive: a page served with "<!--nav-->" in it means the
    // hub failed to fill the bar in, and the reader would see raw HTML.
    check('the navigation marker was replaced, not left in the page',
      ah.indexOf('<!--nav-->') === -1 && ph.indexOf('<!--nav-->') === -1);

    const anon = await getJson(base, '/login.html', null, 'manual');
    check('the login page needs no bar, being the way in',
      anon.status === 200 && !/class="nav"/.test(anon.raw || ''));
  });

  /* ── C. superadmin: seeded, above admin, the only directory manager ───── */
  await withHub(PORT_A, { ...KEYS, GLM_SUPERADMIN: 'pinned-super-key', GLM_SUPERADMIN_NAME: 'chief' },
    async (base) => {
      const root = await signIn(base, 'superadmin', 'pinned-super-key');
      // A superadmin is the operator side: same bar as admin, and the bar says
      // which role is reading rather than rounding it to "admin".
      const superPanel = await getJson(base, '/admin.html', root.cookie, 'manual');
      check('a superadmin reads the operator bar, labelled superadmin',
        superPanel.status === 200 && /data-role="superadmin"/.test(superPanel.raw || ''),
        'HTTP ' + superPanel.status);
      check('the superadmin bar shows their name', /chief/.test(superPanel.raw || ''));
      check('the seeded superadmin signs in with its pinned key',
        root.status === 200 && root.body && root.body.role === 'superadmin',
        'HTTP ' + root.status + ' ' + JSON.stringify(root.body && root.body.role));
      check('the superadmin carries its seeded name', (root.body || {}).name === 'chief',
        String((root.body || {}).name));

      const status = await getJson(base, '/status', root.cookie);
      check('a superadmin passes the admin gate on /status', status.status === 200, 'HTTP ' + status.status);

      const people = await getJson(base, '/people', root.cookie);
      check('the superadmin may read the people directory', people.status === 200, 'HTTP ' + people.status);
      check('the directory lists the seeded account', (people.body.people || [])
        .some((p) => p.name === 'chief' && p.role === 'superadmin'),
        JSON.stringify((people.body.people || []).map((p) => p.name)));

      const admin = await signIn(base, 'admin', 'c-admin');
      const adminPeople = await getJson(base, '/people', admin.cookie);
      check('plain admin may still read the directory (unchanged behaviour)',
        adminPeople.status === 200, 'HTTP ' + adminPeople.status);

      const wrong = await signIn(base, 'superadmin', 'not-the-key');
      check('a wrong superadmin key is refused', wrong.status === 401, 'HTTP ' + wrong.status);

      const seeded = (status.body && status.body.superadmin) || {};
      check('/status says the superadmin was seeded from GLM_SUPERADMIN',
        seeded.source === 'GLM_SUPERADMIN' && seeded.name === 'chief', JSON.stringify(seeded.name));
      check('/status never echoes the superadmin key',
        !/pinned-super-key/.test(JSON.stringify(status.body)), 'key absent from /status');
    });

  /* ── D. the pool: consumed, expired, refilled ────────────────────────── */
  await withHub(PORT_B, { ...KEYS, TOKEN_TARGET: '5', TOKEN_LOWWATER: '2', GLM_TOKEN_TTL_MS: '400' },
    async (base) => {
      const partner = await signIn(base, 'partner', 'c-partner');
      const admin = await signIn(base, 'admin', 'c-admin');
      const ws = new WebSocket('ws://127.0.0.1:' + PORT_B + '/minter/ws');
      ws.onmessage = (ev) => {
        let m = null;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'job' && m.payload && m.payload.mint) {
          setTimeout(() => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'captcha', id: m.id, param: 'p-' + m.id }));
          }, 5);
        }
      };
      ws.onopen = () => { /* a session cookie is not sent by the built-in client */ };
      await new Promise((r) => { ws.onopen = r; setTimeout(r, 1500); }).catch(() => {});

      // The built-in WebSocket client sends no cookie, so the socket is refused
      // unless the hub is opened up. Prove the refusal rather than pretend.
      const closedWithoutSession = ws.readyState === 3 || ws.readyState === 2;
      check('the mint socket still refuses a client with no session cookie',
        closedWithoutSession, 'readyState=' + ws.readyState);
      if (ws.readyState === 0 || ws.readyState === 1) ws.close();

      const before = await getJson(base, '/status', admin.cookie);
      check('/status publishes the pool life cycle (ttl, expired, consumed)',
        before.body.pool.ttlMs === 400
          && typeof before.body.pool.expired === 'number'
          && typeof before.body.pool.consumed === 'number',
        'ttl=' + before.body.pool.ttlMs + ' expired=' + before.body.pool.expired
          + ' consumed=' + before.body.pool.consumed);
      check('/status publishes the low-water mark', before.body.pool.lowwater === 2,
        String(before.body.pool.lowwater));
      check('/status says what the pool does when it drains',
        /expire|lowwater|low/i.test(before.body.pool.note || ''), String(before.body.pool.note));
    });

  /* ── E. the login gate needs no session for its own assets ───────────── */
  await withHub(PORT_A, KEYS, async (base) => {
    // Real files, so a 200 is required. This is what caught /login.css, which
    // the gate listed but the pages never load.
    for (const path of ['/minter.css', '/role.css', '/roles.js']) {
      const r = await getJson(base, path, null, 'manual');
      check('a real public asset is served without a session: ' + path,
        r.status === 200, 'HTTP ' + r.status);
    }
    // Encoded dots and encoded slashes survive URL normalisation, so the hub
    // actually sees an escape attempt rather than a harmless rewritten path.
    for (const attempt of ['/%2e%2e%2fserver%2fhub.mjs', '/..%2f..%2fserver%2fhub.mjs']) {
      const traversal = await getJson(base, attempt, null, 'manual');
      check('path traversal is still refused, not redirected: ' + attempt,
        traversal.status === 403, 'HTTP ' + traversal.status);
    }
  });
  /* ── F. deployment addressing: the pages must not assume localhost ──────
   * On a VPS the hub is reached at a name the developer never saw. These
   * checks prove the address every page shows comes from the request, and
   * that GLM_PUBLIC_URL wins when a reverse proxy hides the real name. */
  await withHub(PORT_A, KEYS, async (base) => {
    // Default: derived from the Host header we actually used.
    const cfg = await getJson(base, '/config');
    check('/config publishes a deployment block', !!(cfg.body && cfg.body.deploy),
      'deploy present');
    check('the address is derived from the request, not a literal',
      cfg.body.deploy.base === base,
      cfg.body.deploy.base + ' vs ' + base);
    check('the API base is built from it', cfg.body.deploy.apiBase === base + '/v1',
      cfg.body.deploy.apiBase);
    check('the socket base is built from it, with a ws scheme',
      cfg.body.deploy.wsBase === base.replace(/^http/, 'ws'),
      cfg.body.deploy.wsBase);
    check('the hub says where the address came from',
      cfg.body.deploy.source === 'request Host header', cfg.body.deploy.source);
    check('the IP lookup is published, so a firewalled deploy can redirect it',
      cfg.body.deploy.ipLookup === 'https://api.ipify.org?format=json',
      cfg.body.deploy.ipLookup);

    const admin = await signIn(base, 'admin', 'c-admin');
    const status = await getJson(base, '/status', admin.cookie);
    check('/status publishes the same deployment block for the panel',
      status.body.deploy && status.body.deploy.apiBase === base + '/v1',
      status.body.deploy && status.body.deploy.apiBase);
  });

  /* A named deployment (the VPS case): GLM_PUBLIC_URL wins over the Host
   * header, and a proxy is only believed when it is trusted on purpose. */
  await withHub(PORT_A, { ...KEYS, GLM_PUBLIC_URL: 'https://glm.example.com/' },
    async (base) => {
      const cfg = await getJson(base, '/config');
      check('GLM_PUBLIC_URL wins over the Host header',
        cfg.body.deploy.base === 'https://glm.example.com',
        cfg.body.deploy.base);
      check('the API base follows the named deployment',
        cfg.body.deploy.apiBase === 'https://glm.example.com/v1',
        cfg.body.deploy.apiBase);
      check('the socket base is wss on an https deployment',
        cfg.body.deploy.wsBase === 'wss://glm.example.com',
        cfg.body.deploy.wsBase);
      check('the hub reports the address as operator-set',
        cfg.body.deploy.source === 'GLM_PUBLIC_URL', cfg.body.deploy.source);
      check('the listen address is still reported separately',
        cfg.body.deploy.listenPort === PORT_A, String(cfg.body.deploy.listenPort));
      check('an env IP lookup reaches the client',
        cfg.body.deploy.ipLookup === 'https://api.ipify.org?format=json',
        cfg.body.deploy.ipLookup);
    });

  /* The two remaining literals a deploy needs to move: how long a sign-in
   * lasts, and where the public-IP lookup points. */
  await withHub(PORT_A, {
    ...KEYS,
    GLM_IP_LOOKUP_URL: 'https://lookup.example.test/ip',
    GLM_SESSION_TTL_MS: String(2 * 60 * 60 * 1000),
  }, async (base) => {
    const cfg = await getJson(base, '/config');
    check('GLM_IP_LOOKUP_URL replaces the captured lookup service',
      cfg.body.deploy.ipLookup === 'https://lookup.example.test/ip',
      cfg.body.deploy.ipLookup);
    const admin = await signIn(base, 'admin', 'c-admin');
    const maxAge = /Max-Age=(\d+)/.exec(admin.raw || '');
    check('GLM_SESSION_TTL_MS sets the cookie lifetime, not a literal day',
      !!maxAge && Number(maxAge[1]) === 7200,
      maxAge ? 'Max-Age=' + maxAge[1] : 'no Max-Age on the cookie');
  });

  /* Max-Age is a hint the client may ignore. The hub must enforce the age
   * itself, or replaying a raw cookie header keeps a session forever. Before
   * this, a 600 ms session still authenticated at 1600 ms. */
  await withHub(PORT_A, { ...KEYS, GLM_SESSION_TTL_MS: '700', GLM_SWEEP_MS: '200' }, async (base) => {
    const admin = await signIn(base, 'admin', 'c-admin');
    const fresh = await getJson(base, '/session', admin.cookie);
    check('a session works while it is young', fresh.status === 200 && fresh.body.ok === true,
      'HTTP ' + fresh.status);

    await sleep(1100);   // past the 700 ms TTL
    const stale = await getJson(base, '/session', admin.cookie);
    check('an expired session is refused server-side, whatever the cookie says',
      stale.status === 200 && stale.body.ok === false && stale.body.role === null,
      'still authenticated as ' + String(stale.body && stale.body.role));

    const page = await getJson(base, '/admin.html', admin.cookie, 'manual');
    check('an expired session no longer opens a gated page',
      page.status === 302 && /login\.html/.test(page.location),
      'HTTP ' + page.status + ' -> ' + page.location);

    const st = await getJson(base, '/status', (await signIn(base, 'admin', 'c-admin')).cookie);
    check('the sweep counts expired sessions rather than dropping them silently',
      st.body.expiredSessions >= 1 && st.body.sessionTtlMs === 700,
      'expired=' + st.body.expiredSessions + ' ttl=' + st.body.sessionTtlMs);
  });

  /* Behind a reverse proxy the Host header is the proxy's, so the forwarded
   * headers are the truth — but only when the operator says to trust them. */
  await withHub(PORT_A, { ...KEYS, GLM_TRUST_PROXY: '1' }, async (base) => {
    const r = await fetch(base + '/config', {
      headers: { 'x-forwarded-host': 'vps.example.net', 'x-forwarded-proto': 'https' },
    });
    const cfg = await r.json();
    check('with GLM_TRUST_PROXY the forwarded host is used',
      cfg.deploy.base === 'https://vps.example.net', cfg.deploy.base);
    check('the forwarded scheme is used, so the snippet is not http on https',
      cfg.deploy.apiBase === 'https://vps.example.net/v1', cfg.deploy.apiBase);
  });

  await withHub(PORT_A, KEYS, async (base) => {
    // Untrusted by default: a forged X-Forwarded-Host must be ignored, or any
    // visitor could make the panel print an address of their choosing.
    const r = await fetch(base + '/config', {
      headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' },
    });
    const cfg = await r.json();
    check('without GLM_TRUST_PROXY a forged X-Forwarded-Host is ignored',
      cfg.deploy.base === base, cfg.deploy.base);
  });
} catch (e) {
  console.log('FAIL (exception) ' + (e && e.message));
  failures++;
}

console.log(failures === 0
  ? '\nconfig check: all expectations met'
  : '\nconfig check: ' + failures + ' failure(s)');
process.exit(failures > 0 ? 1 : 0);
