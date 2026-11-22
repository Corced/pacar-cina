// @ts-check
/* admin.js — control panel for the minter hub.
 *
 * Two modes, same as the minter page:
 *   HUB   — GET /status answers, so the panels fill with real numbers and the
 *           toggles post to /features.
 *   LOCAL — nothing answers. The page then shows the panel shapes with "—"
 *           placeholders and says plainly that no hub is behind it, instead of
 *           inventing numbers. Toggles still flip in the browser so the layout
 *           can be inspected.
 *
 * Clean-room: written from the observed shape of the reference dashboards and
 * the minter page's own message types. No original code copied.
 */
(function () {
  'use strict';

  /** GET /status as this panel reads it. Fields the code tests with `!= null`
   *  stay optional; the few it divides or adds up are required because the
   *  panel already assumes the hub sent them. */
  /** @typedef {{
   *   mode?: string,
   *   port?: number | string,
   *   deploy?: { apiBase?: string, wsBase?: string, source?: string, note?: string },
   *   tokenCount?: number,
   *   userName?: string,
   *   feVersion?: string,
   *   activeSessions?: number,
   *   expiredSessions?: number,
   *   authMode?: string,
   *   wsAuth?: string,
   *   minter?: {
   *     online?: number, served?: number, inflight?: number, egressIps?: string,
   *     jobTimeoutMs?: number, spread?: string
   *   },
   *   pool?: {
   *     available: number, target: number, lowwater: number,
   *     low?: boolean, consumed?: number, expired?: number, ttlMs?: number,
   *     donatedTokens?: number, donatedSessions?: number
   *   },
   *   people?: { count?: number, storage?: string, list?: Person[] },
   *   upstream?: { configured?: boolean },
   *   chat?: {
   *     requests?: number, ok?: number, failed?: number, lastModel?: string,
   *     lastStatus?: number, poolSpent?: number, throttled?: number
   *   },
   *   chatLimit?: { inFlight: number, concurrency: number },
   *   donationLimit?: { verifying: number, concurrency: number, throttled?: number },
   *   chatLedger?: { recent?: { id: string, who?: string, turns?: number }[] },
   *   captcha?: { checked?: number, valid?: number, invalid?: number },
   *   features?: { [k: string]: boolean },
   *   models?: string[],
   *   partners?: Partner[]
   * }} Status */

  /** One row of GET /status's partner list. */
  /** @typedef {{
   *   id: string, person?: string, ip?: string, role?: string,
   *   proto?: string, mints?: number
   * }} Partner */

  /** One row of /status's people list. */
  /** @typedef {{
   *   name: string, role: string, source?: string, pinned?: string,
   *   uses?: number, donations?: number
   * }} Person */

  /** One row of GET /tokens?all=1's donation list. */
  /** @typedef {{
   *   status: string, kind: string, fp: string, person?: string, checkedAt?: number
   * }} Donation */

  /** window plus the one thing this page reads off it. */
  /** @typedef {Window & { GLM_HUB_URL?: string }} AdminWindow */

  var win = /** @type {AdminWindow} */ (/** @type {unknown} */ (window));

  var STATUS_POLL_MS = 5000;   // the reference dashboards poll every 5 s
  var HUB = (win.GLM_HUB_URL || '').replace(/\/$/, '') || location.origin;
  var api = HUB + '/status';

  var hasHub = false;
  var started = Date.now();
  var authState = 'unknown';   // unknown | ok | needed | forbidden

  /** @param {string} id @returns {HTMLElement | null} */
  function $(id) { return document.getElementById(id); }
  /** @param {string} id @returns {HTMLInputElement | null} */
  function input(id) { return /** @type {HTMLInputElement | null} */ ($(id)); }
  /** @param {string} id @returns {HTMLSelectElement | null} */
  function select(id) { return /** @type {HTMLSelectElement | null} */ ($(id)); }
  /** @param {string} id @returns {HTMLButtonElement | null} */
  function button(id) { return /** @type {HTMLButtonElement | null} */ ($(id)); }

  /** @param {string} id @param {unknown} v */
  function setText(id, v) {
    var el = $(id);
    if (el) el.textContent = (v === undefined || v === null || v === '') ? '—' : String(v);
  }

  /* Show the key prompt: this panel now needs an admin session. */
  /** @param {string} msg */
  function needKey(msg) {
    authState = 'needed';
    var box = $('akeybox');
    if (!box) return;
    box.hidden = false;
    var why = $('akeywhy');
    if (why) why.textContent = msg || 'This panel needs an admin session.';
    // The panel's own markup always carries these two pills.
    var health = /** @type {HTMLElement} */ ($('a-health'));
    health.className = 'pill bad';
    health.innerHTML = '<span class="dot off"></span>locked';
    var mode = /** @type {HTMLElement} */ ($('a-mode'));
    mode.className = 'pill bad';
    mode.textContent = 'needs admin key';
  }

  function grabKey() {
    var f = input('akey');
    var v = f ? f.value.trim() : '';
    var box = $('akeybox');
    if (!v) { log('no key entered'); return; }
    // Try admin first, then superadmin: a superadmin key is not an admin key
    // (each role checks only its own), and the panel is the only way a
    // superadmin can reach the people controls. Both sessions satisfy
    // isAdminish, so /status answers for either.
    postSession('admin', v)
      .then(function (o) {
        if (o.s === 200) return { s: 200, d: o.d, role: 'admin' };
        if (o.s !== 401) return { s: o.s, d: o.d, role: 'admin' };
        return postSession('superadmin', v).then(function (o2) {
          return { s: o2.s, d: o2.d, role: 'superadmin' };
        });
      })
      .then(function (o) {
        if (o.s !== 200) throw new Error(o.d.error || ('HTTP ' + o.s));
        authState = 'ok';
        if (box) box.hidden = true;
        if (f) f.value = '';   // never keep it in the page
        log('signed in as ' + o.role);
        refresh();
        applyRoleGates();
      })
      .catch(function (e) {
        var why = $('akeywhy');
        var err = e instanceof Error ? e.message : String(e);
        if (why) why.textContent = 'That key was not accepted: ' + err;
        log('admin sign-in failed: ' + err);
      });
  }

  /** @param {string} role @param {string} key @returns {Promise<{ s: number, d: any }>} */
  function postSession(role, key) {
    return fetch(HUB + '/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: role, key: key }),
    }).then(function (r) { return r.json().then(function (d) { return { s: r.status, d: d }; }); });
  }

  /** @param {string} msg */
  function log(msg) {
    var box = $('alog');
    if (!box) return;
    var t = new Date().toISOString().slice(11, 19);
    var row = document.createElement('div');
    row.textContent = t + '  ' + msg;
    box.insertBefore(row, box.firstChild);
    // childElementCount > 60 means there is a last child to drop.
    while (box.childElementCount > 60) box.removeChild(/** @type {ChildNode} */ (box.lastChild));
  }

  /** @returns {string} */
  function uptime() {
    var s = Math.floor((Date.now() - started) / 1000);
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  /* ── panel fill ─────────────────────────────────────────────── */

  /** @param {Status} d */
  function fillStatus(d) {
    hasHub = true;

    var health = /** @type {HTMLElement} */ ($('a-health'));
    health.className = 'pill ok';
    health.innerHTML = '<span class="dot on"></span>running';
    // A live hub answered: the pill stops claiming it is still checking.
    var live = /** @type {HTMLElement} */ ($('a-mode'));
    live.className = 'pill ok';
    live.textContent = 'connected';

    setText('s-up', d.mode || 'direct');
    setText('s-listen', d.port ? ':' + d.port : '—');
    // The address comes from the hub, which works it out from the request it
    // received. On a VPS that is the real name, not a localhost literal.
    var dep = d.deploy || {};
    setText('s-ep', dep.apiBase || (location.origin + '/v1'));
    setText('s-ws', (dep.wsBase || (location.origin.replace(/^http/, 'ws'))) + '/minter/ws');
    var depNote = document.getElementById('s-deploy-note');
    if (depNote) {
      depNote.textContent = dep.source
        ? 'Address worked out from ' + dep.source + '. ' + (dep.note || '')
        : 'The hub did not report its address; using this page\'s origin.';
    }
    var snip = document.getElementById('curl-snippet');
    if (snip) {
      var api = dep.apiBase || (location.origin + '/v1');
      snip.textContent = 'curl -X POST ' + api + '/chat/completions \\\n'
        + '  -H "Content-Type: application/json" \\\n'
        + '  -H "Authorization: Bearer <AUTH_TOKEN>" \\\n'
        + '  -d \'{"model":"z.ai/glm-5.3-think","messages":[{"role":"user","content":"Hello"}],"stream":false}\'';
    }
    setText('s-store', d.tokenCount != null ? d.tokenCount + ' tokens' : '—');
    setText('s-user', d.userName);
    setText('s-fe', d.feVersion);
    setText('s-sessions', d.activeSessions != null ? d.activeSessions : '0');
    setText('s-expired', d.expiredSessions != null ? d.expiredSessions : '0');
    setText('s-authmode', d.authMode);
    setText('s-wsauth', d.wsAuth);

    if (d.minter) {
      var m = d.minter;
      setText('p-online', m.online);
      setText('p-served', m.served);
      setText('p-inflight', m.inflight);
      setText('p-ips', m.egressIps);
      setText('p-timeout', m.jobTimeoutMs != null ? m.jobTimeoutMs + ' ms' : '—');
      setText('p-spread', m.spread || '—');
    }

    if (d.pool) {
      var p = d.pool;
      setText('t-avail', p.available);
      setText('t-target', p.target);
      setText('t-low', p.lowwater);
      setText('t-used', p.consumed);
      setText('t-expired', p.expired != null ? p.expired : 0);
      setText('t-ttl', p.ttlMs != null ? Math.round(p.ttlMs / 60000) + ' min' : '—');
      setText('t-donated',
        (p.donatedTokens || 0) + ' tokens + ' + (p.donatedSessions || 0) + ' sessions');
      var tl = document.getElementById('t-lifecycle');
      if (tl) {
        // The hub publishes `lowwater`, not `low`; comparing against the value
        // it actually sends is what makes this sentence true.
        var below = p.available != null && p.lowwater != null
          ? p.available <= p.lowwater
          : !!p.low;
        tl.textContent = 'Life cycle: an entry is usable for ' + (p.ttlMs != null
          ? Math.round(p.ttlMs / 60000) + ' minutes' : 'a set time')
          + ', then the sweep moves it to expired (' + (p.expired || 0) + ' so far, '
          + (p.consumed || 0) + ' consumed). ' + (below ? 'Below low-water: the hub is asking '
          + 'partners for more now.' : 'Above low-water, so nothing extra is being asked for.')
          + ' Nothing spends an entry yet — there is no live upstream to spend it on.';
      }
    }

    // People registry: who holds which key.
    if (d.people) {
      setText('pp-count', d.people.count);
      if (d.people.storage) setText('pp-storage', d.people.storage);
      if (Array.isArray(d.people.list)) fillPeople(d.people.list);
    }

    // Upstream + chat traffic.
    if (d.upstream) {
      setText('u-config', d.upstream.configured ? 'yes' : 'no');
    }
    if (d.chat) {
      setText('u-req', d.chat.requests);
      setText('u-ok', d.chat.ok);
      setText('u-bad', d.chat.failed);
      setText('u-model', d.chat.lastModel || '—');
      setText('u-status', d.chat.lastStatus == null ? '-' : d.chat.lastStatus);
      setText('u-spent', d.chat.poolSpent == null ? '-' : d.chat.poolSpent);
      setText('u-throttled', d.chat.throttled == null ? '-' : d.chat.throttled);
    }
    if (d.chatLimit) {
      setText('u-inflight', d.chatLimit.inFlight + ' / ' + d.chatLimit.concurrency);
    }
    if (d.donationLimit) {
      setText('d-verifying', d.donationLimit.verifying + ' / ' + d.donationLimit.concurrency);
      setText('d-throttled', d.donationLimit.throttled);
    }
    if (d.chatLedger && d.chatLedger.recent && d.chatLedger.recent.length) {
      var lastChat = d.chatLedger.recent[0];
      setText('u-chat', lastChat.id.slice(-8) + ' · ' + lastChat.who
        + (lastChat.turns ? ' · ' + lastChat.turns + ' turn(s)' : ''));
    }

    // Captcha verification counters.
    if (d.captcha) {
      setText('cv-count', d.captcha.checked);
      setText('cv-valid', d.captcha.valid);
      setText('cv-invalid', d.captcha.invalid);
    }

    if (d.pool) {
      var p = d.pool;
      var pct = p.target ? Math.min(100, Math.round((p.available / p.target) * 100)) : 0;
      var bar = $('t-bar');
      if (bar) bar.style.width = pct + '%';
      var wrap = $('t-bar-wrap');
      if (wrap) wrap.className = 'bar-meter' + (p.available <= p.lowwater ? ' low' : '');
    }

    if (d.features) {
      var feats = d.features;   // the callback below is a separate function to the checker
      Object.keys(feats).forEach(function (k) {
        var el = /** @type {HTMLElement | null} */ (document.querySelector('[data-feat="' + k + '"]'));
        if (el) setOn(el, !!feats[k]);
      });
    }

    // Model catalog summary: bases seen across the ids.
    if (Array.isArray(d.models)) {
      /** @type {string[]} */ var bases = [];
      d.models.forEach(function (id) {
        var afterSlash = id.indexOf('/') >= 0 ? id.slice(id.indexOf('/') + 1) : id;
        var base = afterSlash;
        ['-think', '-search', '-deepresearch'].forEach(function (sfx) {
          if (base.slice(-sfx.length) === sfx) base = base.slice(0, -sfx.length);
        });
        if (bases.indexOf(base) < 0) bases.push(base);
      });
      setText('m-bases', bases.join(' · ') || '—');
      setText('m-count', d.models.length + ' ids');
    }

    if (Array.isArray(d.partners)) {
      var body = /** @type {HTMLElement} */ ($('pt-body'));
      if (!d.partners.length) {
        body.innerHTML = '<tr><td colspan="6" style="color:var(--mut)">no partners connected</td></tr>';
      } else {
        body.textContent = '';
        d.partners.forEach(function (p2) {
          var tr = document.createElement('tr');
          /** @type {[string | number, string][]} */
          var cells = [
            [p2.id, 'mono'],
            [p2.person || '—', ''],
            [p2.ip || '—', 'mono'],
            [p2.role || 'anon', ''],
            ['v' + (p2.proto || '?'), ''],
            [p2.mints != null ? p2.mints : 0, '']
          ];
          cells.forEach(function (cell) {
            var td = document.createElement('td');
            if (cell[1]) td.className = cell[1];
            td.textContent = String(cell[0]);
            tr.appendChild(td);
          });
          body.appendChild(tr);
        });
      }
    }

    refreshDonations();
  }


  // People table: one row per person, with the two actions that end their access.
  // A pinned person's buttons are disabled rather than hidden — the reason is
  // visible instead of the row silently lacking a control.
  /** @param {Person[]} list */
  function fillPeople(list) {
    var body = $('pp-body');
    if (!body) return;
    body.textContent = '';
    if (!list.length) {
      var empty = document.createElement('tr');
      var td0 = document.createElement('td');
      td0.colSpan = 6;
      td0.style.color = 'var(--mut)';
      td0.textContent = 'no people registered';
      empty.appendChild(td0);
      body.appendChild(empty);
      return;
    }
    var box = body;   // the callback below is a separate function to the checker
    list.forEach(function (p) {
      var tr = document.createElement('tr');
      var name = document.createElement('td');
      name.className = 'mono';
      name.textContent = p.name;
      tr.appendChild(name);

      var role = document.createElement('td');
      var pill = document.createElement('span');
      pill.className = 'pill ' + (p.role === 'superadmin' ? 'bad' : p.role === 'admin' ? 'warn' : 'info');
      pill.textContent = p.role;
      role.appendChild(pill);
      tr.appendChild(role);

      var src = document.createElement('td');
      src.textContent = p.source || (p.pinned ? 'pinned' : 'directory');
      tr.appendChild(src);

      var uses = document.createElement('td');
      uses.textContent = String(p.uses == null ? '—' : p.uses);
      tr.appendChild(uses);

      var don = document.createElement('td');
      don.textContent = String(p.donations == null ? '—' : p.donations);
      tr.appendChild(don);

      var acts = document.createElement('td');
      acts.style.whiteSpace = 'nowrap';
      [['Rotate', 'rotate', 'btn'], ['Revoke', 'revoke', 'btn danger']].forEach(function (spec) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = spec[2];
        b.textContent = spec[0];
        b.style.marginLeft = '4px';
        b.disabled = !!p.pinned;
        if (p.pinned) b.title = 'this account cannot be rotated or revoked from the API — ' + p.pinned;
        else b.addEventListener('click', function () { personAction(spec[1], p.name); });
        acts.appendChild(b);
      });
      tr.appendChild(acts);
      box.appendChild(tr);
    });
  }

  // One place for both mutations: POST, then re-read the panel. Rotation hands
  // back the new key exactly once, so it is shown until the next action and
  // never fetched again — the hub does not keep it readable.
  /** @param {string} what @param {string} name */
  function personAction(what, name) {
    if (what === 'revoke' && !window.confirm('Revoke ' + name + '? Their key, sessions and open sockets stop now.')) return;
    var url = HUB + '/people/' + what;
    fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name }),
    })
      .then(function (r) { return r.json().then(function (d) { return { s: r.status, d: d }; }); })
      .then(function (o) {
        var out = $('pp-newkey');
        if (o.s !== 200) {
          log('people/' + what + ' refused for ' + name + ': ' + ((o.d && (o.d.reason || o.d.error)) || ('HTTP ' + o.s)));
          if (out) { out.textContent = ''; }
          return;
        }
        if (what === 'rotate' && o.d.key) {
          if (out) out.textContent = name + ' new key: ' + o.d.key;
          log('rotated the key for ' + name + ' (' + o.d.sessions + ' session(s) dropped) — copy it now');
        } else {
          if (out) out.textContent = name + ' revoked';
          log('revoked ' + name + ' (' + o.d.sessions + ' session(s), ' + o.d.sockets + ' socket(s) dropped)');
        }
        refresh();
      })
      .catch(function (e) { log(what + ' failed: ' + (e instanceof Error ? e.message : String(e))); });
  }

  function createPerson() {
    var nameEl = input('pp-name');
    var roleEl = select('pp-role');
    var name = nameEl ? nameEl.value.trim() : '';
    if (!name) { log('a person needs a name'); return; }
    fetch(HUB + '/people', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name, role: roleEl ? roleEl.value : 'partner' }),
    })
      .then(function (r) { return r.json().then(function (d) { return { s: r.status, d: d }; }); })
      .then(function (o) {
        var out = $('pp-newkey');
        if (o.s !== 201) {
          log('create refused: ' + ((o.d && o.d.error) || ('HTTP ' + o.s)));
          return;
        }
        if (out) out.textContent = o.d.name + ' created — key (shown once): ' + o.d.key;
        if (nameEl) nameEl.value = '';
        log('created person ' + o.d.name + ' (' + o.d.role + ')');
        refresh();
      })
      .catch(function (e) { log('create failed: ' + (e instanceof Error ? e.message : String(e))); });
  }

  // Donations table: fingerprints + statuses, admin only. Never any value.
  function refreshDonations() {
    fetch('/tokens?all=1', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        /** @type {{ [k: string]: string }} */
        var pillIds = { valid: 'd-valid', invalid: 'd-invalid', unverified: 'd-unverified' };
        if (d && d.ok && Array.isArray(d.donations)) {
          setText('d-held', d.donations.length);
          /** @type {{ [k: string]: number }} */
          var counts = { valid: 0, invalid: 0, unverified: 0 };
          d.donations.forEach(/** @param {Donation} x */ function (x) {
            if (counts[x.status] !== undefined) counts[x.status]++;
          });
          Object.keys(pillIds).forEach(function (k) {
            setText(pillIds[k], k + ' ' + counts[k]);
          });
          var body = $('dn-body');
          if (!body) return;
          if (!d.donations.length) {
            body.innerHTML = '<tr><td colspan="5" style="color:var(--mut)">no donations held</td></tr>';
            return;
          }
          body.textContent = '';
          var box = body;   // the callback below is a separate function to the checker
          d.donations.forEach(/** @param {Donation} x */ function (x) {
            var tr = document.createElement('tr');
            var st = document.createElement('span');
            st.className = 'pill ' + (x.status === 'valid' ? 'ok' : x.status === 'invalid' ? 'bad' : 'info');
            st.textContent = x.status;
            /** @type {[string | HTMLElement, string][]} */
            var cells = [
              [x.kind, ''],
              [x.fp, 'mono'],
              [x.person || '—', ''],
              [st, ''],
              [x.checkedAt ? new Date(x.checkedAt).toISOString().slice(11, 19) + ' UTC' : '—', 'mono']
            ];
            cells.forEach(function (cell) {
              var td = document.createElement('td');
              if (cell[1]) td.className = cell[1];
              if (cell[0] instanceof Element) td.appendChild(cell[0]);
              else td.textContent = String(cell[0]);
              tr.appendChild(td);
            });
            box.appendChild(tr);
          });
        }
      })
      .catch(function () { /* no hub: leave the shape */ });
  }

  /** @param {string} reason */
  function noHub(reason) {
    hasHub = false;
    var health = /** @type {HTMLElement} */ ($('a-health'));
    health.className = 'pill warn';
    health.innerHTML = '<span class="dot off"></span>no hub';
    var mode = /** @type {HTMLElement} */ ($('a-mode'));
    mode.className = 'pill warn';
    mode.textContent = 'static preview';
    log('no hub at ' + api + ' (' + reason + ') — panels show shape only');
  }

  /* ── polling ────────────────────────────────────────────────── */

  function refresh() {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl && ctl.abort(); }, 4000) : null;

    fetch(api, {
      signal: ctl ? ctl.signal : undefined,
      credentials: 'same-origin',          // the session cookie must ride along
      headers: { accept: 'application/json' },
    })
      .then(function (r) {
        if (timer) clearTimeout(timer);
        // A static host answers /status with its HTML fallback. Treating that
        // as hub data would be a lie, so check the type before parsing.
        var ct = r.headers.get('content-type') || '';
        if (ct.indexOf('json') === -1) throw new Error('no JSON at /status (static host)');

        // The panel is no longer open: say so instead of showing stale numbers.
        if (r.status === 401) { needKey('A session is required to read this panel.'); return null; }
        if (r.status === 403) {
          authState = 'forbidden';
          needKey('Your session is not the admin role. Sign in as admin.');
          return null;
        }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        if (!d) return;
        authState = 'ok';
        var box = $('akeybox');
        if (box) box.hidden = true;
        fillStatus(d || {});
      })
      .catch(function (e) {
        if (timer) clearTimeout(timer);
        var mode = /** @type {HTMLElement} */ ($('a-mode'));
        if (!mode.textContent.match(/static/)) noHub((e instanceof Error ? e.message : String(e)) || 'unreachable');
      })
      .then(function () { setText('s-up-time', uptime()); });
  }

  /* ── toggles (work locally; post when a hub exists) ─────────── */

  /** @param {HTMLElement} el @param {boolean} on */
  function setOn(el, on) {
    el.textContent = on ? 'ON' : 'OFF';
    el.className = 'tog ' + (on ? 'on' : 'off');
  }

  document.querySelectorAll('[data-feat]').forEach(function (node) {
    var el = /** @type {HTMLElement} */ (node);
    el.addEventListener('click', function () {
      var on = el.textContent !== 'ON';
      setOn(el, on);
      /** @type {{ [k: string]: boolean }} */ var body = {}; body[/** @type {string} */ (el.dataset.feat)] = on;
      if (!hasHub) { log('feature ' + el.dataset.feat + ' -> ' + (on ? 'on' : 'off') + ' (local only)'); return; }
      fetch(HUB + '/features', {
        method: 'POST',
        credentials: 'same-origin',          // the session cookie must ride along
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (r) {
        if (r.status === 401 || r.status === 403) {
          setOn(el, !on);                    // the hub refused: do not paint a lie
          log('feature ' + el.dataset.feat + ' refused (HTTP ' + r.status + '): an admin session is needed');
          return;
        }
        log('feature ' + el.dataset.feat + ' -> ' + (on ? 'on' : 'off'));
      }).catch(function (e) { log('feature post failed: ' + (e instanceof Error ? e.message : String(e))); });
    });
  });

  document.querySelectorAll('[data-egress]').forEach(function (node) {
    var el = /** @type {HTMLElement} */ (node);
    el.addEventListener('click', function () {
      var on = el.textContent !== 'ON';
      setOn(el, on);
      log('egress ' + el.dataset.egress + ' -> ' + (on ? 'on' : 'off') + (hasHub ? '' : ' (local only)'));
    });
  });

  var btn = button('a-refresh');
  if (btn) btn.addEventListener('click', function () { refresh(); log('manual refresh'); });

  var go = button('akeygo');
  if (go) go.addEventListener('click', grabKey);
  var keyIn = input('akey');
  if (keyIn) keyIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') grabKey(); });

  var clr = button('a-clear');
  if (clr) clr.addEventListener('click', function () {
    var box = $('alog'); if (box) box.textContent = '';
    log('log cleared');
  });

  var reset = button('a-reset');
  if (reset) reset.addEventListener('click', function () {
    if (!hasHub) { log('drop partners: no hub to obey this (local only)'); return; }
    fetch(HUB + '/admin/session/clear', { method: 'POST', credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) {
          log('drop refused (HTTP ' + r.status + '): an admin session is needed');
          return;
        }
        return r.json().then(function (d) { log('dropped ' + d.dropped + ' partner session(s)'); });
      })
      .catch(function (e) { log('drop failed: ' + (e instanceof Error ? e.message : String(e))); });
  });

  var addPerson = button('pp-add');
  if (addPerson) addPerson.addEventListener('click', createPerson);
  var nameIn = input('pp-name');
  if (nameIn) nameIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') createPerson(); });
  // Creating is superadmin-only, so an admin sees a disabled control with the
  // reason instead of a button that silently 403s.
  function applyRoleGates() {
    fetch(HUB + '/session', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var add = button('pp-add');
        var nameIn = input('pp-name');
        var sel = select('pp-role');
        var superadmin = Boolean(d && d.ok && d.role === 'superadmin');
        if (add) {
          add.disabled = !superadmin;
          add.title = superadmin ? '' : 'only a superadmin may create people';
        }
        if (nameIn) nameIn.disabled = !superadmin;
        if (sel) sel.disabled = !superadmin;
      })
      .catch(function () { /* no hub: leave the shape */ });
  }
  applyRoleGates();

  /* ── start ──────────────────────────────────────────────────── */

  // If the hub bounced an admin here from another role's page, say why.
  (function wrongRoleNote() {
    var q;
    try { q = new URLSearchParams(location.search).get('wrongrole'); } catch { return; }
    if (!q) return;
    var anchor = $('akeybox');
    if (!anchor || !anchor.parentNode) return;
    var box = document.createElement('div');
    box.className = 'warnbox';
    box.textContent = 'That page belongs to a different role, so it sent you to the panel. '
      + 'You are signed in as ' + q + '; use the bar above to move around.';
    anchor.parentNode.insertBefore(box, anchor);
  })();

  log('admin panel ready — polling ' + api);
  refresh();
  setInterval(refresh, STATUS_POLL_MS);
  setInterval(function () { setText('s-up-time', uptime()); }, 1000);
})();
