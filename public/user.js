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
   *   }
   * }} Self */

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
    refresh();
    setInterval(refresh, POLL_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refresh();
    });
  }

  win.USER = { mount: mount, refresh: refresh };
})();