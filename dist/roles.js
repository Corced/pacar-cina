/* roles.js — the login memory and the three role pages.
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
  const KEY = 'glm2api.role';
  const HUB = window.GLM_HUB_URL ? String(window.GLM_HUB_URL).replace(/\/$/, '') : '';

  /* The page each role owns. A visitor who signs in on the front door is taken
   * here, so the sign-in page is a door and not a waiting room. Kept in step
   * with ROLE_HOME in server/hub.mjs, which does the same after "/". */
  const HOME = {
    user: '/user.html',
    partner: '/partner.html',
    admin: '/admin.html',
    superadmin: '/admin.html',
  };

  /* Is a hub on this origin? Asked once, cached, so pages can say which mode
   * they are in rather than guessing. A static host answers /status with HTML,
   * so the content-type is the tell (same check admin.js makes). */
  let hubProbe = null;
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
  function remember(r) {
    try { localStorage.setItem(KEY, r); } catch { /* private mode: fine */ }
  }

  // Silent 30 Hz oscillator. Identical approach to the minter page: a running
  // AudioContext makes the browser treat the tab as playing audio, which makes
  // it far less likely to freeze or throttle it. It is inaudible.
  let ac = null, osc = null, armed = false;
  function arm() {
    if (armed) { paintArm(); return; }
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
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
    if (window.GLM_IP_LOOKUP_URL) return window.GLM_IP_LOOKUP_URL;
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
  const LINES = [];
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
    el.parentNode.insertBefore(box, el);
  }

  // Flip switches and remember them. Purely cosmetic: nothing reads them yet.
  function switches(scope) {
    document.querySelectorAll('[data-sw]').forEach((s) => {
      const key = scope + '.' + s.dataset.sw;
      let on = false;
      try { on = localStorage.getItem(key) === '1'; } catch {}
      s.setAttribute('aria-checked', on ? 'true' : 'false');
      s.addEventListener('click', () => {
        const next = s.getAttribute('aria-checked') !== 'true';
        s.setAttribute('aria-checked', next ? 'true' : 'false');
        try { localStorage.setItem(key, next ? '1' : '0'); } catch {}
        log((s.dataset.name || s.dataset.sw) + (next ? ' on' : ' off') + ' (this browser only)');
      });
    });
  }

  function pill() {
    const r = role();
    const el = document.getElementById('who');
    if (!el) return;
    if (!r) { el.className = 'who'; el.textContent = 'no role chosen'; return; }
    el.className = 'who ' + r;
    el.textContent = r;
  }

  function noHub() {
    // Stated once per page so nobody reads these numbers as live pool data.
    log('No hub server is running here — nothing on this page is sent anywhere.');
  }

  /* ── login ─────────────────────────────────────────────────── */
  /* Where a gated page wanted to go. A deliberate redirect target from the hub,
   * so it is checked to be a same-origin path: anything absolute is ignored. */
  function loginNext(fallback) {
    try {
      var q = new URLSearchParams(location.search).get('next');
      if (!q) return fallback;
      var dec = decodeURIComponent(q);
      return dec.charAt(0) === '/' && dec.charAt(1) !== '/' ? dec : fallback;
    } catch { return fallback; }
  }

  function mountLogin() {
    var form = document.getElementById('keyform');
    var input = document.getElementById('keyinput');
    var submit = document.getElementById('keygo');

    // Where to go once a session exists: the page the visitor asked for.
    // Kept in the query string so a redirect survives a reload.


    document.querySelectorAll('#roles .role').forEach((a) => {
      const r = a.dataset.role;
      if (role() === r) a.setAttribute('aria-pressed', 'true');
      a.addEventListener('click', (ev) => {
        remember(r);
        // Privileged roles need a key before the hub will grant the session.
        hub().then((h) => {
          if (!h.present) {
            setSignNote('No hub on this origin, so no session was issued: the role is only '
              + 'remembered in this browser. Start the hub (npm run hub) to get a signed one.', 'warn');
            if (form) form.hidden = true;
            return;
          }
          if (r === 'user') {
            // Open on purpose: lending your own IP grants no access to anyone else.
            if (form) form.hidden = true;
            return signIn(r, null);
          }
          if (form) {
            form.hidden = false;
            input.value = '';
            input.focus();
            setSignNote('Signing in as ' + r + ' needs that role\'s key, which the hub printed '
              + 'when it started (or set it with GLM_KEYS / GLM_SUPERADMIN). This is a key, not a '
              + 'password: there are no accounts.', 'mut');
          }
        });
      });
    });

    function doKey() {
      var want = role();
      if (want !== 'partner' && want !== 'admin' && want !== 'superadmin') {
        return setSignNote('Pick the partner, admin or superadmin role first.', 'warn');
      }
      signIn(want, input.value.trim());
    }
    if (submit) submit.addEventListener('click', doKey);
    if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') doKey(); });

    // Say up front which mode this page is in.
    hub().then((h) => {
      if (h.present) {
        setSignNote('A hub answered. Sessions are signed, and the partner and admin roles now '
          + 'require their key — the role is granted by the key, not by you picking it.', 'ok');
      } else {
        setSignNote('No hub on this origin. Choosing a role only remembers it in this browser; '
          + 'nothing is issued and nothing is checked. Run "npm run hub" to change that.', 'warn');
      }
    });
  }

  function signIn(r, key) {
    setSignNote('Asking the hub for a ' + r + ' session…', 'mut');
    var body = { role: r };
    if (key) body.key = key;
    // A person can sign under their own name if the form carries one; the
    // hub only accepts it when that person's own key was given too.
    var nameBox = document.getElementById('personname');
    if (nameBox && nameBox.value.trim()) body.name = nameBox.value.trim();
    return fetch((HUB || '') + '/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((res) => res.json().then((d) => ({ status: res.status, d })))
      .then(({ status, d }) => {
        if (status !== 200) throw new Error(d.error || ('HTTP ' + status));
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

  function setSignNote(text, kind) {
    const el = document.getElementById('signnote');
    if (!el) return;
    el.textContent = text;
    el.className = kind === 'ok' ? 'note' : 'note';
    el.style.color = kind === 'bad' ? 'var(--bad)'
      : kind === 'warn' ? 'var(--warn)'
      : kind === 'ok' ? 'var(--ok)' : 'var(--mut)';
  }

  /* ── user ──────────────────────────────────────────────────── */
  function mountUser() {
    pill(); armOnGesture(); ip(); startUptime(); switches('user');
    wrongRoleNote();
    log('Signed in as user (open role: no key, since lending your own IP risks nothing).');
    noHub();
    log('You can offer this IP as an egress point once a hub is listening.');
  }

  /* ── partner ───────────────────────────────────────────────── */
  function mountPartner() {
    pill(); armOnGesture(); ip(); startUptime(); switches('partner');
    wrongRoleNote();
    log('Signed in as partner (this browser only — not verified anywhere).');
    noHub();

    // The token/session form. With a hub listening and a partner/admin session
    // cookie, submitting POSTs the value to /tokens, which stores only a
    // fingerprint. Without a hub, nothing is sent and the page says so.
    const form = document.getElementById('addform');
    const status = document.getElementById('donate-status');
    function say(text, kind) {
      if (!status) return;
      status.textContent = text;
      status.style.color = kind === 'bad' ? 'var(--bad)'
        : kind === 'ok' ? 'var(--ok)' : 'var(--mut)';
    }
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const kind = document.getElementById('kind').value;
        const box = document.getElementById('secret');
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
            box.textContent = d.mine.map((m) =>
              m.kind + ' ' + m.fp.slice(0, 8) + '…: ' + m.status).join(' · ');
          } else {
            box.textContent = d && d.ok ? 'nothing of yours held yet' : '';
          }
        })
        .catch(() => { /* no hub */ });
    }
    refreshContrib();

    log('Allowance rises with verified tokens and sessions — and each donation is now checked against Aliyun as it arrives, so "verified" means a real exchange answered.');
  }

  return { role, mountLogin, mountUser, mountPartner, arm, log };
})();
