// @ts-check
/* user.js — the user page, rebuilt around what the hub can actually report.
 *
 * Plain ES5 the browser runs as-is: the `@ts-check` line and the JSDoc below are
 * comments to it, and `npm run check` type-checks them with `tsc` when one is on
 * PATH. There is no build step.
 *
 * One endpoint: GET /status/self, polled every 5 s. This page is a report, not a
 * control — the minter tab (index.html) holds the socket, and a captcha is solved
 * there or nowhere. Nothing here can start, stop or change that.
 *
 * The rule the page is built on: never show a figure that was not read on this
 * refresh. When the hub cannot answer, every number goes back to a dash and the
 * page says why, rather than leaving the last number up looking current.
 */
(function () {
  'use strict';

  /** GET /status/self as this page reads it — every field optional, because an
   *  older hub is allowed to send less and the page must not invent the rest. */
  /** @typedef {{
   *   ok?: boolean,
   *   role?: string,
   *   error?: string | { message?: string, type?: string },
   *   you?: {
   *     name?: string | null,
   *     address?: string | null,
   *     offered?: boolean,
   *     sockets?: number,
   *     mints?: number,
   *     since?: number
   *   },
   *   poolNow?: {
   *     tokens?: number, inflight?: number, online?: number,
   *     minted?: number, failed?: number, target?: number, lowwater?: number
   *   },
   *   myKeys?: UpKey[]
   * }} Self */

  /** One row of the shared upstream-token pool, from /status/self's myKeys.
   *  Metadata only: the hub never returns the token itself. */
  /** @typedef {{
   *   id: string, source: string, addedBy?: string, at?: number, uses?: number,
   *   lastUsed?: number | null, health: string, jwt?: boolean
   * }} UpKey */

  /** What the log remembers between refreshes, so it only reports a change. */
  /** @typedef {{ tokens?: number | null, online?: number | null, offered?: boolean | null, since?: number | null }} LastSeen */

  /** window plus the object this page puts on it. */
  /** @typedef {Window & { GLM_HUB_URL?: string, USER?: { mount: () => void, refresh: () => void } }} UserWindow */

  var win = /** @type {UserWindow} */ (/** @type {unknown} */ (window));
  var HUB = (win.GLM_HUB_URL || '').replace(/\/$/, '');
  var POLL_MS = 5000;

  /** @type {'up' | 'down' | null} */ var state = null;   // for the log, which should not repeat itself
  var lastWhy = '';
  /** @type {LastSeen} */ var last = {};                 // last logged values, so only changes are logged

  var FIELDS = [
    'y-name', 'y-addr', 'y-sockets', 'y-mints', 'y-since',
    'p-tokens', 'p-target', 'p-low', 'p-inflight', 'p-online', 'p-minted', 'p-failed',
  ];

  /** @param {string} id @returns {HTMLElement | null} */
  function $(id) { return document.getElementById(id); }

  /** @param {string} id @param {unknown} v */
  function set(id, v) {
    var el = $(id);
    if (!el) return;
    el.textContent = (v === null || v === undefined || v === '') ? '—' : String(v);
  }

  // A figure exists only when the hub sent it as a number.
  /** @param {any} obj @param {string} key @returns {number | null} */
  function num(obj, key) {
    if (!obj) return null;
    var v = obj[key];
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }

  /** @param {unknown} v @returns {string} */
  function show(v) { return (v === null || v === undefined) ? '—' : String(v); }

  /** @type {string[]} */ var lines = [];
  /** @param {string} line */
  function log(line) {
    lines.unshift(new Date().toLocaleTimeString() + ' — ' + line);
    if (lines.length > 40) lines.pop();
    var el = $('log');
    if (!el) return;
    var box = el;   // the callback below is a separate function to the checker
    while (box.firstChild) box.removeChild(box.firstChild);
    lines.forEach(function (l) {
      var row = document.createElement('div');
      row.textContent = l;
      box.appendChild(row);
    });
  }

  /* ── shared upstream bearer tokens ──────────────────────────────
   * The same compact block partner.html carries, so the two pages read as one
   * feature. The hub answers with metadata only, so nothing here may echo a
   * token: the input is cleared when the gate answers and the notice area
   * prints the gate's own lines, verbatim, instead of a sentence of ours. */

  /* ok / unverified / dead / refused are the whole vocabulary. `unverified` is
   * blue with a tooltip on purpose: not yet proven, never "valid". */
  /** @param {string} h @returns {HTMLElement} */
  function healthTag(h) {
    var el = document.createElement('span');
    el.className = 'tag ' + (h === 'ok' ? 'ok'
      : h === 'dead' || h === 'refused' ? 'bad'
        : h === 'unverified' ? 'info' : 'mut');
    el.textContent = h || '—';
    if (h === 'unverified') el.title = 'not yet proven: nothing has checked this token';
    return el;
  }

  /** @param {string[]} lines @param {string} kind */
  function keysSay(lines, kind) {
    var box = $('uk-say');
    if (!box) return;
    var out = box;   // the callback below is a separate function to the checker
    out.textContent = '';
    var color = kind === 'bad' ? 'var(--bad)' : kind === 'ok' ? 'var(--ok)' : 'var(--mut)';
    lines.forEach(function (l) {
      var row = document.createElement('div');
      row.textContent = l;
      row.style.color = color;
      out.appendChild(row);
    });
  }

  /** @param {any} d @returns {string[]} */
  function checksOf(d) {
    if (!d || !Array.isArray(d.checks)) return [];
    return d.checks.filter(function (/** @type {unknown} */ x) { return typeof x === 'string'; });
  }

  /* The hub's own reason, quoted; nothing invented. A 409 also names the row
   * that already holds the token, which is metadata and useful. */
  /** @param {number} status @param {any} d @returns {string} */
  function keysReason(status, d) {
    var e = d && d.error;
    var why = typeof e === 'string' ? e : (e && (e.message || e.type)) || '';
    if (status === 409) {
      return why + (d && d.id ? ' (id ' + d.id + ', health ' + d.health + ')' : '');
    }
    return why || ('HTTP ' + status);
  }

  // Nothing was read, so the table says so rather than keeping old rows up.
  function keysUnread() {
    var body = $('uk-body');
    if (!body) return;
    body.textContent = '';
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    td.colSpan = 5;
    td.style.color = 'var(--mut)';
    td.textContent = 'not read yet';
    tr.appendChild(td);
    body.appendChild(tr);
  }

  /** @param {UpKey[]} rows */
  function fillKeys(rows) {
    var body = $('uk-body');
    if (!body) return;
    body.textContent = '';
    if (!rows.length) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 5;
      td.style.color = 'var(--mut)';
      td.textContent = 'nothing of yours is held';
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    var box = body;   // the callback below is a separate function to the checker
    rows.forEach(function (k) {
      var tr = document.createElement('tr');
      var id = document.createElement('td');
      id.className = 'mono';
      id.textContent = k.id;
      tr.appendChild(id);
      var src = document.createElement('td');
      src.textContent = k.source;
      tr.appendChild(src);
      var health = document.createElement('td');
      health.appendChild(healthTag(k.health));
      tr.appendChild(health);
      var uses = document.createElement('td');
      uses.textContent = String(k.uses == null ? '—' : k.uses);
      tr.appendChild(uses);
      var acts = document.createElement('td');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = 'Revoke';
      b.addEventListener('click', function () { revokeKey(k.id); });
      acts.appendChild(b);
      tr.appendChild(acts);
      box.appendChild(tr);
    });
  }

  function contributeKey() {
    var sel = /** @type {HTMLSelectElement | null} */ ($('uk-source'));
    var box = /** @type {HTMLInputElement | null} */ ($('uk-key'));
    var key = box ? box.value.trim() : '';
    if (!key) { keysSay(['nothing to send — paste a token first'], 'bad'); return; }
    fetch(HUB + '/upstream/keys', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: sel ? sel.value : 'z.ai', key: key }),
    })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
      .then(function (o) {
        var d = o.d;
        if (o.status === 200 && d && d.ok) {
          if (box) box.value = '';       // a token never stays on screen
          keysSay(['held as ' + d.id + ' for ' + d.source + ' — health: ' + d.health].concat(checksOf(d)), '');
          log('Contributed an upstream token for ' + d.source + ': held as ' + d.id + ', health ' + d.health + '.');
          refresh();
          return;
        }
        keysSay([keysReason(o.status, d)].concat(checksOf(d)), 'bad');
        log('The hub refused an upstream token: ' + keysReason(o.status, d) + ' (nothing was stored).');
      })
      .catch(function () {
        keysSay(['No hub on this origin — nothing was sent, and the token was not read anywhere.'], 'bad');
        log('No hub listening: the upstream token was not sent anywhere.');
        if (box) box.value = '';
      });
  }

  /** @param {string} id */
  function revokeKey(id) {
    if (!window.confirm('Revoke upstream token ' + id + '? Any chat call spending it stops at once.')) return;
    fetch(HUB + '/upstream/keys/revoke', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: id }),
    })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
      .then(function (o) {
        if (o.status !== 200) {
          keysSay(['revoke refused: ' + keysReason(o.status, o.d)], 'bad');
          log('Upstream token ' + id + ' was not revoked (HTTP ' + o.status + ').');
          return;
        }
        keysSay(['revoked ' + id + ' — the hub dropped it from memory'], 'ok');
        log('Revoked upstream token ' + id + '.');
        refresh();
      })
      .catch(function () { keysSay(['No hub answered — nothing was revoked.'], 'bad'); });
  }

  /* ── what the hub said ──────────────────────────────────────── */

  /** @param {Self} d */
  function render(d) {
    var you = d.you || null;
    var pool = d.poolNow || null;
    var role = String(d.role || '');

    var who = $('who');
    if (who) {
      who.className = 'who' + (role === 'user' || role === 'partner' || role === 'admin' ? ' ' + role : '');
      who.textContent = role || 'signed in';
    }

    // This caller, as the hub saw it. A null name is a real answer: the role,
    // not a person, is what signed in.
    set('y-name', you ? (you.name || (role ? 'no name — signed in by ' + role + ' role' : null)) : null);
    set('y-addr', you ? you.address : null);

    var off = (you && typeof you.offered === 'boolean') ? you.offered : null;
    var pill = $('y-offered');
    if (pill) {
      pill.className = 'pill' + (off === true ? ' ok' : off === null ? ' warn' : '');
      pill.textContent = off === true ? 'offered' : off === false ? 'not offered' : 'not reported';
    }

    set('y-sockets', num(you, 'sockets'));
    set('y-mints', num(you, 'mints'));
    var since = num(you, 'since');
    set('y-since', since ? new Date(since).toLocaleString() : null);

    // The pool.
    var tokens = num(pool, 'tokens');
    var target = num(pool, 'target');
    set('p-tokens', tokens);
    set('p-target', target);
    set('p-low', num(pool, 'lowwater'));
    set('p-inflight', num(pool, 'inflight'));
    var online = num(pool, 'online');
    set('p-online', online);
    set('p-minted', num(pool, 'minted'));
    set('p-failed', num(pool, 'failed'));

    var bar = $('p-bar');
    if (bar) bar.style.width = (tokens !== null && target) ? Math.min(100, Math.round((tokens / target) * 100)) + '%' : '0%';

    // The tokens this caller contributed. An older hub that does not send
    // myKeys leaves the placeholder up instead of being read as "none".
    if (Array.isArray(d.myKeys)) fillKeys(d.myKeys);

    var gaps = [];
    if (!you) gaps.push('you');
    if (!pool) gaps.push('poolNow');
    var note = $('readnote');
    if (note) {
      note.textContent = 'Read at ' + new Date().toLocaleTimeString() + ' · refreshed every '
        + (POLL_MS / 1000) + 's. '
        + (gaps.length
          ? 'This hub does not send ' + gaps.join(' or ') + ' on /status/self — it is older than this '
            + 'page — so those rows stay dashes instead of being invented.'
          : 'A dash means that field was missing, not zero.');
    }

    if (state !== 'up') {
      log('Reporting from the hub: ' + show(tokens) + ' tokens, ' + show(online) + ' minter socket(s) connected.');
      state = 'up';
      lastWhy = '';
    } else {
      if (tokens !== last.tokens) log('Tokens now ' + show(tokens) + (target ? ' of ' + target : '') + '.');
      if (online !== last.online) log('Minter sockets connected: ' + show(online) + '.');
      if (last.offered !== undefined && off !== null && off !== last.offered) {
        log(off ? 'This address is now an egress exit.' : 'This address is no longer an egress exit.');
      }
      if (since && since !== last.since) {
        log('Sockets from this address have been connected since ' + new Date(since).toLocaleString() + '.');
      }
    }
    last = { tokens: tokens, online: online, offered: off, since: since };
  }

  /* Nothing was read, so nothing is shown: every figure becomes a dash. */
  /** @param {string} why */
  function down(why) {
    FIELDS.forEach(function (id) { set(id, null); });
    keysUnread();
    var bar = $('p-bar');
    if (bar) bar.style.width = '0%';
    var pill = $('y-offered');
    if (pill) { pill.className = 'pill warn'; pill.textContent = 'not read'; }
    var who = $('who');
    if (who) { who.className = 'who'; who.textContent = 'not read'; }
    var note = $('readnote');
    if (note) note.textContent = why;
    if (state !== 'down' || lastWhy !== why) log(why);
    state = 'down';
    lastWhy = why;
    last = {};
  }

  function refresh() {
    fetch(HUB + '/status/self', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
      .then(function (r) {
        return r.text().then(function (t) {
          /** @type {any} */ var d = null;
          try { d = JSON.parse(t); } catch (e) { /* a static host answers HTML */ }
          return { status: r.status, d: d };
        });
      })
      .then(function (o) {
        if (!o.d || typeof o.d !== 'object') {
          down('No hub on this origin: /status/self answered with a page, not JSON, so there is nothing '
            + 'to report. These dashes are not zeros.');
          return;
        }
        if (o.status === 401) {
          down('The hub is here, but this tab has no session (401), so it reports nothing about you. '
            + 'Sign in at login.html and come back.');
          return;
        }
        if (o.status !== 200 || !o.d.ok) {
          var e = o.d.error;
          var why = typeof e === 'string' ? e : (e && (e.message || e.type)) || '';
          down('The hub answered HTTP ' + o.status + (why ? ': ' + why : '') + '. Nothing above is a '
            + 'stale figure — it was cleared when this read failed.');
          return;
        }
        render(/** @type {Self} */ (o.d));
      })
      .catch(function () {
        down('No hub on this origin — the request never left the browser, so there is nothing to '
          + 'report. Start the hub (npm run hub) and this page fills in.');
      });
  }

  function mount() {
    log('This page reports; it does not solve. The minter tab (index.html) is where solving happens.');
    var form = $('uk-form');
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); contributeKey(); });
    refresh();
    setInterval(refresh, POLL_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refresh();
    });
  }

  win.USER = { mount: mount, refresh: refresh };
})();