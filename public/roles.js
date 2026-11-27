// @ts-check
/* roles.js - the login key field and the role pages.
 *
 * Everything here runs in the browser only. There is no server: no session is
 * issued, no role is verified, nothing is stored anywhere but this browser.
 * The pages say so plainly; this script must not pretend otherwise.
 *
 * The parts that are real, because they need no server:
 *   - showing your own egress IP (api.ipify.org, as the original page does)
 *   - remembering which role you picked, so the header pill is right
 *   - keeping the tab awake (silent oscillator, same trick as the minter page)
 *   - counting the minutes you have contributed this session
 * It answers only localhost/static: a hub is not present, and the pages say so.
 */
const ROLES = (() => {

  /** window plus the switches a deployment can set before this script loads. */
  /** @typedef {Window & typeof globalThis & {
   *   GLM_HUB_URL?: string,
   *   GLM_IP_LOOKUP_URL?: string,
   *   webkitAudioContext?: typeof AudioContext
   * }} RolesWindow */

  var win = /** @type {RolesWindow} */ (/** @type {unknown} */ (window));

  const KEY = 'glm2api.role';
  const HUB = win.GLM_HUB_URL ? String(win.GLM_HUB_URL).replace(/\/$/, '') : '';

  /* The page each role owns. A visitor who signs in on the front door is taken
   * here, so the sign-in page is a door and not a waiting room. Kept in step
   * with ROLE_HOME in server/hub.mjs, which does the same after "/". */
  /** @type {Record<string, string>} */
  const HOME = {
    user: '/user.html',
    partner: '/partner.html',
    admin: '/admin.html',
    superadmin: '/admin.html',
  };

  /* Is a hub on this origin? Asked once, cached, so pages can say which mode
   * they are in rather than guessing. A static host answers /status with HTML,
   * so the content-type is the tell (same check admin.js makes). */
  /** What /session answered the first time it was asked, so it is asked once. */
  /** @typedef {{ present: boolean, role: string | null }} HubProbe */

  /** One row of the shared upstream-token pool. Metadata only — the hub never
   *  returns the token, so nothing here can echo one. */
  /** @typedef {{
   *   id: string, source: string, addedBy?: string, at?: number, uses?: number,
   *   lastUsed?: number | null, health: string, jwt?: boolean
   * }} UpKey */

  /** @type {Promise<HubProbe> | null} */
  let hubProbe = null;
  /** @returns {Promise<HubProbe>} */
  function hub() {
    if (hubProbe) return hubProbe;
    hubProbe = fetch((HUB || '') + '/session', { headers: { accept: 'application/json' } })
      .then((r) => {
        const ct = r.headers.get('content-type') || '';
        if (ct.indexOf('json') === -1) throw new Error('not a hub');
        return r.json();
      })
      .then((d) => ({ present: true, role: d.role || null }))
      .catch(() => ({ present: false, role: null }));
    return hubProbe;
  }

  /* ── shared bits ───────────────────────────────────────────── */

  function role() {
    try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
  }
  /** @param {string} r */
  function remember(r) {
    try { localStorage.setItem(KEY, r); } catch { /* private mode: fine */ }
  }

  // Silent 30 Hz oscillator. Identical approach to the minter page: a running
  // AudioContext makes the browser treat the tab as playing audio, which makes
  // it far less likely to freeze or throttle it. It is inaudible.
  let ac = /** @type {AudioContext | null} */ (null), osc = null, armed = false;
  function arm() {
    if (armed) { paintArm(); return; }
    try {
      ac = ac || new (win.AudioContext || win.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
      osc = ac.createOscillator();
      const g = ac.createGain();
      g.gain.value = 0.01;            // effectively silent
      osc.frequency.value = 30;       // below most speakers
      osc.connect(g); g.connect(ac.destination);
      osc.start();
      armed = true;
    } catch { armed = false; }
    paintArm();
  }
  function paintArm() {
    const el = document.getElementById('arm');
    if (!el) return;
    if (armed) {
      el.className = 'warnbox';
      el.style.background = 'rgba(63,185,80,.1)';
      el.style.borderColor = 'rgba(63,185,80,.35)';
      el.style.color = 'var(--ok)';
      el.innerHTML = '<b>Background mode armed.</b> This tab will keep running while you work elsewhere.';
    } else {
      el.innerHTML = '<b style="color:var(--bad)">Tap anywhere to arm background mode</b> — until then this tab may be throttled or frozen when you switch away.';
    }
  }
  function armOnGesture() {
    ['pointerdown', 'touchstart', 'keydown', 'click'].forEach((e) =>
      window.addEventListener(e, arm, { passive: true }));
    paintArm();
  }

  // The visitor's own egress address, as the original page shows it.
  /* The lookup service comes from the hub when one answers, so a deployment
   * behind a firewall can substitute its own. The captured default stands in
   * when there is no hub (the static, no-backend case). */
  const IP_DEFAULT = 'https://api.ipify.org?format=json';

  async function ipLookupUrl() {
    if (win.GLM_IP_LOOKUP_URL) return win.GLM_IP_LOOKUP_URL;
    try {
      const r = await fetch('/config', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        if (j && j.deploy && j.deploy.ipLookup) return j.deploy.ipLookup;
      }
    } catch { /* no hub: use the captured default */ }
    return IP_DEFAULT;
  }

  async function ip() {
    const el = document.getElementById('ip');
    try {
      const url = await ipLookupUrl();
      if (!url) {
        if (el) el.textContent = 'not looked up (disabled here)';
        return null;
      }
      const r = await fetch(url, { cache: 'no-store' });
      const j = await r.json();
      if (el) el.textContent = j.ip;
      return j.ip;
    } catch {
      if (el) el.textContent = 'unavailable';
      return null;
    }
  }

  // How long this tab has been contributing. Local, honest, not a credential.
  function startUptime() {
    const t0 = Date.now();
    const el = document.getElementById('uptime');
    if (!el) return;
    setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      el.textContent = s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    }, 1000);
  }

  // A tiny log, same shape as the minter page's.
  /** @type {string[]} */
  const LINES = [];
  /** @param {string} text */
  function log(text) {
    LINES.unshift(new Date().toLocaleTimeString() + ' — ' + text);
    if (LINES.length > 40) LINES.pop();
    const el = document.getElementById('log');
    if (el) el.innerHTML = LINES.map((l) => '<div>' + l + '</div>').join('');
  }

  // If the hub bounced this visitor here from another role's page, say why.
  // The hub put the role in the query string; it is display-only text.
  function wrongRoleNote() {
    var q;
    try { q = new URLSearchParams(location.search).get('wrongrole'); } catch { return; }
    if (!q) return;
    var el = document.getElementById('arm');
    if (!el) return;
    var box = document.createElement('div');
    box.className = 'warnbox';
    box.textContent = 'That page belongs to a different role, so it sent you to your own. '
      + 'You are signed in as ' + q + '; use the bar above to move around.';
    /** @type {HTMLElement} */ (el.parentNode).insertBefore(box, el);
  }

  

  function pill() {
    const r = role();
    const el = document.getElementById('who');
    if (!el) return;
    if (!r) { el.className = 'who'; el.textContent = 'no role chosen'; return; }
    el.className = 'who ' + r;
    el.textContent = r;
  }

  /** @param {string} sends */
  function noHub(sends) {
    // This used to be a fixed claim, which became a lie the moment the partner
    // form learned to POST. Probe instead, and say which of the two situations
    // this actually is. A static host answers the path with HTML, not the hub's
    // JSON, so a failed parse is still "no hub".
    fetch('/status/self', { credentials: 'same-origin' })
      .then((r) => r.text().then((t) => {
        let body = null;
        try { body = JSON.parse(t); } catch { /* a static host answers HTML, not the hub */ }
        // 200 (signed in) and 401 (hub, no session) are the two the hub gives;
        // anything else is a static host's 404 for a path it does not have.
        const hub = body && typeof body === 'object' && (r.status === 200 || r.status === 401);
        if (!hub) { log('No hub on this origin - nothing on this page is sent anywhere.'); return; }
        log(r.status === 200
          ? 'Hub answers on this origin. ' + sends
          : 'Hub answers on this origin, but this tab has no session - sign in before anything can count.');
      }))
      .catch(() => log('No hub on this origin - nothing on this page is sent anywhere.'));
  }

  /* ── login ─────────────────────────────────────────────────── */
  /* Where a gated page wanted to go. A deliberate redirect target from the hub,
   * so it is checked to be a same-origin path: anything absolute is ignored. */
  /** @param {string} fallback @returns {string} */
  function loginNext(fallback) {
    try {
      var q = new URLSearchParams(location.search).get('next');
      if (!q) return fallback;
      var dec = decodeURIComponent(q);
      return dec.charAt(0) === '/' && dec.charAt(1) !== '/' ? dec : fallback;
    } catch { return fallback; }
  }

  /* One key field and no role list. A page that lists the roles tells every
   * visitor how many there are and what each may do; the key already names its
   * role, so the hub resolves it (POST /session with {key} and no role). A
   * visitor with no key is the open role, which grants nothing but lending an
   * address. */
  function mountLogin() {
    var form = /** @type {HTMLFormElement | null} */ (document.getElementById('keyform'));
    var input = /** @type {HTMLInputElement} */ (document.getElementById('keyinput'));
    var guest = document.getElementById('keyguest');

    // Enter comes free: the box is a real <form>, which is also what password
    // managers and the browser's own "field outside a form" warning look for.
    if (form) form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      signIn(input ? input.value.trim() : '');
    });
    if (guest) guest.addEventListener('click', function (ev) { ev.preventDefault(); signIn(''); });

    // Say up front which mode this page is in.
    hub().then((h) => {
      if (h.present) {
        setSignNote('A hub answered on this origin. Paste the key you were given, or continue '
          + 'without one.', 'ok');
      } else {
        setSignNote('No hub on this origin, so nothing can be signed in here. Start it with '
          + '"npm run hub" and reload.', 'warn');
      }
    });
  }

  /** @param {string} key — the key, or '' for the open role */
  function signIn(key) {
    setSignNote('Asking the hub for a session…', 'mut');
    /** @type {{ key?: string }} */
    var body = {};
    if (key) body.key = key;
    // No name field: the key already says who the caller is, and the hub reads
    // the person off it. A name offered by a page would be checked, never
    // believed, so there is nothing for one to add here.
    return fetch((HUB || '') + '/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((res) => res.json().then((d) => ({ status: res.status, d })))
      .then(({ status, d }) => {
        if (status !== 200) throw new Error(d.error || ('HTTP ' + status));
        remember(d.role);
        setSignNote('Signed in as ' + d.role
          + (d.name ? ' (' + d.name + ')' : '') + '. ' + d.note + '.', 'ok');
        var go = document.getElementById('keygo');
        if (go) go.textContent = 'signed in';
        // A gated page sent us here with ?next=…; go there now that we may.
        // Otherwise go to the page this role owns, because signing in on the
        // front door and being left staring at it looks like nothing happened.
        var dest = loginNext(HOME[d.role] || '');
        if (dest) setTimeout(function () { location.href = dest; }, 350);
      })
      .catch((e) => setSignNote('Hub refused the session: ' + e.message, 'bad'));
  }

  /** @param {string} text @param {string} kind */
  function setSignNote(text, kind) {
    const el = document.getElementById('signnote');
    if (!el) return;
    el.textContent = text;
    el.className = kind === 'ok' ? 'note' : 'note';
    el.style.color = kind === 'bad' ? 'var(--bad)'
      : kind === 'warn' ? 'var(--warn)'
      : kind === 'ok' ? 'var(--ok)' : 'var(--mut)';
  }

  /* ── shared upstream bearer tokens ───────────────────────────
   * The same compact block partner.html and user.html carry. The hub's gate
   * answers with metadata only — id, source, health — so nothing here may echo
   * a token: the input is cleared the moment the gate answers, and the notice
   * area prints the gate's own lines verbatim instead of a sentence of ours. */

  /* ok / unverified / dead / refused are the whole vocabulary. `unverified` is
   * blue with a tooltip on purpose: not yet proven, never "valid". */
  /** @param {string} h @returns {HTMLElement} */
  function healthTag(h) {
    const el = document.createElement('span');
    el.className = 'tag ' + (h === 'ok' ? 'ok'
      : h === 'dead' || h === 'refused' ? 'bad'
        : h === 'unverified' ? 'info' : 'mut');
    el.textContent = h || '—';
    if (h === 'unverified') el.title = 'not yet proven: nothing has checked this token';
    return el;
  }

  /** @param {string[]} lines @param {string} kind */
  function keysSay(lines, kind) {
    const box = document.getElementById('uk-say');
    if (!box) return;
    box.textContent = '';
    lines.forEach((l) => {
      const row = document.createElement('div');
      row.textContent = l;
      row.style.color = kind === 'bad' ? 'var(--bad)'
        : kind === 'ok' ? 'var(--ok)' : 'var(--mut)';
      box.appendChild(row);
    });
  }

  /** @param {any} d @returns {string[]} */
  function checksOf(d) {
    if (!d || !Array.isArray(d.checks)) return [];
    return d.checks.filter((/** @type {unknown} */ x) => typeof x === 'string');
  }

  /* The hub's own reason, quoted; nothing invented. A 409 also names the row
   * that already holds the token, which is metadata and useful. */
  /** @param {number} status @param {any} d @returns {string} */
  function keysReason(status, d) {
    const e = d && d.error;
    const why = typeof e === 'string' ? e : (e && (e.message || e.type)) || '';
    if (status === 409) {
      return why + (d && d.id ? ' (id ' + d.id + ', health ' + d.health + ')' : '');
    }
    return why || ('HTTP ' + status);
  }

  /** @param {UpKey[]} rows */
  function fillKeys(rows) {
    const body = document.getElementById('uk-body');
    if (!body) return;
    body.textContent = '';
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.style.color = 'var(--mut)';
      td.textContent = 'nothing of yours is held';
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    rows.forEach((k) => {
      const tr = document.createElement('tr');
      const id = document.createElement('td');
      id.className = 'mono';
      id.textContent = k.id;
      tr.appendChild(id);
      const src = document.createElement('td');
      src.textContent = k.source;
      tr.appendChild(src);
      const health = document.createElement('td');
      health.appendChild(healthTag(k.health));
      tr.appendChild(health);
      const uses = document.createElement('td');
      uses.textContent = String(k.uses == null ? '—' : k.uses);
      tr.appendChild(uses);
      const acts = document.createElement('td');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = 'Revoke';
      b.addEventListener('click', () => { revokeKey(k.id); });
      acts.appendChild(b);
      tr.appendChild(acts);
      body.appendChild(tr);
    });
  }

  /* Only a read the hub actually answered is rendered: a 401 or a static host
   * leaves the "not read yet" placeholder up rather than claiming "none". */
  function refreshKeys() {
    fetch('/status/self', { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || !Array.isArray(d.myKeys)) return;
        fillKeys(d.myKeys);
      })
      .catch(() => { /* nothing was read: the placeholder stays a placeholder */ });
  }

  function contributeKey() {
    const sel = /** @type {HTMLSelectElement} */ (document.getElementById('uk-source'));
    const box = /** @type {HTMLInputElement | null} */ (document.getElementById('uk-key'));
    const key = box ? box.value.trim() : '';
    if (!key) { keysSay(['nothing to send — paste a token first'], 'bad'); return; }
    fetch('/upstream/keys', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: sel.value, key: key }),
    })
      .then((r) => r.json().then((d) => ({ status: r.status, d }), () => ({ status: r.status, d: null })))
      .then(({ status: code, d }) => {
        if (code === 200 && d && d.ok) {
          if (box) box.value = '';       // a token never stays on screen
          keysSay(['held as ' + d.id + ' for ' + d.source + ' — health: ' + d.health].concat(checksOf(d)), '');
          log('Contributed an upstream token for ' + d.source + ': held as ' + d.id + ', health ' + d.health + '.');
          refreshKeys();
          return;
        }
        keysSay([keysReason(code, d)].concat(checksOf(d)), 'bad');
        log('The hub refused an upstream token: ' + keysReason(code, d) + ' (nothing was stored).');
      })
      .catch(() => {
        keysSay(['No hub on this origin — nothing was sent, and the token was not read anywhere.'], 'bad');
        log('No hub listening: the upstream token was not sent anywhere.');
        if (box) box.value = '';
      });
  }

  /** @param {string} id */
  function revokeKey(id) {
    if (!window.confirm('Revoke upstream token ' + id + '? Any chat call spending it stops at once.')) return;
    fetch('/upstream/keys/revoke', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: id }),
    })
      .then((r) => r.json().then((d) => ({ status: r.status, d }), () => ({ status: r.status, d: null })))
      .then(({ status: code, d }) => {
        if (code !== 200) {
          keysSay(['revoke refused: ' + keysReason(code, d)], 'bad');
          log('Upstream token ' + id + ' was not revoked (HTTP ' + code + ').');
          return;
        }
        keysSay(['revoked ' + id + ' — the hub dropped it from memory'], 'ok');
        log('Revoked upstream token ' + id + '.');
        refreshKeys();
      })
      .catch(() => keysSay(['No hub answered — nothing was revoked.'], 'bad'));
  }

  function mountKeys() {
    const form = document.getElementById('uk-form');
    if (!form) return;
    form.addEventListener('submit', (e) => { e.preventDefault(); contributeKey(); });
    refreshKeys();
  }

  /* ── partner ───────────────────────────────────────────────── */
  function mountPartner() {
    pill(); armOnGesture(); ip(); startUptime();
    wrongRoleNote();
    log('Signed in as partner (this browser only — not verified anywhere).');
    noHub('The donation form below really POSTs to /tokens, and the counts above come from it.');

    // The token/session form. With a hub listening and a partner/admin session
    // cookie, submitting POSTs the value to /tokens, which stores only a
    // fingerprint. Without a hub, nothing is sent and the page says so.
    const form = document.getElementById('addform');
    const status = document.getElementById('donate-status');
    /** @param {string} text @param {string} kind */
    function say(text, kind) {
      if (!status) return;
      status.textContent = text;
      status.style.color = kind === 'bad' ? 'var(--bad)'
        : kind === 'ok' ? 'var(--ok)' : 'var(--mut)';
    }
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const kind = /** @type {HTMLSelectElement} */ (document.getElementById('kind')).value;
        const box = /** @type {HTMLInputElement} */ (document.getElementById('secret'));
        if (!box.value.trim()) { say('Nothing to add — paste a ' + kind + ' first.', 'bad'); return; }
        // Never echo the value itself into the log or anywhere else.
        fetch('/tokens', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: kind, value: box.value }),
        }).then((r) => r.json().then((d) => ({ status: r.status, body: d }), () => ({ status: r.status, body: null })))
          .then(({ status: code, body }) => {
            if (code === 200 && body && body.ok) {
              say(body.duplicate
                ? 'Already held (fingerprint ' + body.fp + ') — nothing added twice.'
                : 'Handed to the hub (fingerprint ' + body.fp + '). ' + body.donated + ' held. It is being checked with Aliyun now — the answer appears in "Yours" below in a moment.', 'ok');
              log('Donated a ' + kind + ' — the hub kept the fingerprint only.');
              box.value = '';
              refreshContrib();
            } else if (code === 401) {
              say('The hub refused: sign in at login.html first (partner key needed).', 'bad');
              log('Donation refused — no partner session.');
            } else if (code === 403) {
              say('The hub refused: donating is for the partner or admin role.', 'bad');
              log('Donation refused — wrong role.');
            } else if (code === 429) {
              // The hub verifies a few at a time; a 429 is a queue, not a ban.
              const err = (body && body.error) || {};
              say('The hub is still checking ' + (err.limit || 4)
                + ' of your donations with Aliyun — wait '
                + (err.retry_after_seconds || 2) + 's, then paste again. Nothing was added.', 'bad');
              log('Donation refused — too many checks in flight for this account.');
            } else {
              const why = body && body.error;
              say('The hub refused: '
                + (typeof why === 'string' ? why : (why && why.message) || ('HTTP ' + code)), 'bad');
              log('Donation refused — value kept out of the pool.');
            }
          })
          .catch(() => {
            say('No hub on this origin — nothing was sent, and the value was discarded.', 'bad');
            log('No hub listening: the paste was not read anywhere.');
            box.value = '';
          });
      });
    }

    // What the pool holds, refreshed on load and after each donation.
    function refreshContrib() {
      fetch('/tokens', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          const t = document.getElementById('c-tokens');
          const s = document.getElementById('c-sessions');
          if (d && d.ok) {
            if (t) t.textContent = String(d.tokens);
            if (s) s.textContent = String(d.sessions);
            say(d.held + ' held: ' + d.valid + ' valid, ' + d.invalid + ' invalid, '
              + d.unverified + ' unverified. ' + d.note, '');
          } else if (t && s) {
            t.textContent = '—'; s.textContent = '—';
          }
        })
        .catch(() => { /* no hub: leave the dashes */ });
      // This person's own donations, with their verification statuses.
      fetch('/tokens?mine=1', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          const box = document.getElementById('c-mine');
          if (!box) return;
          if (d && d.ok && d.mine.length) {
            box.textContent = d.mine.map((/** @type {any} */ m) =>
              m.kind + ' ' + m.fp.slice(0, 8) + '…: ' + m.status).join(' · ');
          } else {
            box.textContent = d && d.ok ? 'nothing of yours held yet' : '';
          }
        })
        .catch(() => { /* no hub */ });
    }
    refreshContrib();
    mountKeys();

    log('Allowance rises with verified tokens and sessions — and each donation is now checked against Aliyun as it arrives, so "verified" means a real exchange answered.');
  }

  return { role, mountLogin, mountPartner, arm, log };
})();
