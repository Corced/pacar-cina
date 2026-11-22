// @ts-check
/* minter.js — clean-room rebuild of the minter page's controller script.
 *
 * Observed behaviour it reproduces (capture/page.html inline script + how-it-works.md):
 *   1. background-mode arming: a silent audio "heartbeat" (an oscillator the
 *      browser keeps scheduling) is created on the first pointer/touch/key/
 *      click gesture; until then a red warning shows.
 *   2. connection: WebSocket to /minter/ws on the page's origin; on open it
 *      sends {type:'hello', ip, proto:2} (IP from api.ipify.org), pings every
 *      25s, answers server pings with pong, and reconnects with backoff
 *      800ms growing ×1.7 capped at 15s.
 *   3. mint jobs: on {type:'job', id, payload:{mint:true}} it mints a captcha
 *      (via GLM.mintCaptchaSerialized) and replies {type:'captcha', id, param}
 *      or {type:'error', id, kind:'upstream', detail, code} on failure.
 *      Non-mint jobs are refused — the page is mint-only by design.
 *   4. UI: stats (status / mints / in flight), an activity log capped at 40
 *      lines (newest first), and the visitor's public IP display.
 *
 * This build is served as plain static files, so there is usually no hub
 * WebSocket behind /minter/ws. When the hub answers, the page talks to it
 * exactly like the original. When it doesn't, the page runs a local demo
 * pool (jobs spaced 20–45s apart with jitter, so mints are spread evenly
 * instead of bunching up) and keeps quietly retrying the hub in the
 * background; the activity log always says which mode is running.
 */
(function () {
  'use strict';

  /** The one call this page makes on glm-client.js's global — the whole surface it reads. */
  /** @typedef {{ mintCaptchaSerialized: () => Promise<any> }} GlmClient */

  /** A job payload from the hub: mint-only, and untrusted JSON. */
  /** @typedef {{ mint?: boolean }} MintJob */

  /** One message from the hub over the minter socket — untrusted JSON. */
  /** @typedef {{ type?: string, id?: string, payload?: any }} HubMessage */

  /** window plus what this page reads off it. */
  /** @typedef {Window & {
   *   GLM_HUB_URL?: string,
   *   GLM_IP_LOOKUP_URL?: string,
   *   GLM?: GlmClient
   * }} MinterWindow */

  var win = /** @type {MinterWindow} */ (/** @type {unknown} */ (window));
  var GLM = /** @type {GlmClient} */ (/** @type {any} */ (win).GLM);

  // webkitAudioContext is the prefixed one, so it is not on the Window type.
  var AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;

  /** @param {string} id @returns {HTMLElement | null} */
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- 1. background-mode arming ---------- */

  var audioCtx = /** @type {AudioContext | null} */ (null), osc = /** @type {OscillatorNode | null} */ (null), armed = false;

  function armKeepAlive() {
    try {
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      if (!osc) {
        osc = audioCtx.createOscillator();
        osc.frequency.value = 30;
        var gain = audioCtx.createGain();
        gain.gain.value = 0.01;
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.start();
      }
      armed = (audioCtx.state === 'running');
    } catch (e) { armed = false; }
    paintKeepAlive();
  }

  function paintKeepAlive() {
    var el = $('w-keep');
    if (!el) return;
    if (armed) {
      el.innerHTML = '<b style="color:var(--ok)">Background mode armed.</b> This tab keeps minting when you switch away.';
    } else {
      el.innerHTML = '<b style="color:var(--bad)">Tap anywhere to arm background mode</b> — until then this tab may be throttled or frozen when you switch away.';
    }
  }

  ['pointerdown', 'touchstart', 'keydown', 'click'].forEach(function (ev) {
    document.addEventListener(ev, function () { if (!armed) armKeepAlive(); }, { passive: true });
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && !armed) armKeepAlive();
    if (document.visibilityState === 'visible' && ws && ws.readyState !== 1) connect();
  });
  armKeepAlive();

  /* ---------- 2. connection to the mint hub ---------- */

  var served = 0, failed = 0, inflight = 0;
  var ws = /** @type {WebSocket | null} */ (null), backoff = 800, logEl = /** @type {HTMLElement} */ ($('wlog')), logged = 0;
  var PROTO = 2;
  var PING_EVERY_MS = 25000;
  var HUB_RETRY_WHEN_DEMO_MS = 30000;
  var everOpened = false;
  var pingTimer = /** @type {ReturnType<typeof setInterval> | null} */ (null), hubProbeTimer = /** @type {ReturnType<typeof setInterval> | null} */ (null), refuseTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
  var wsSupported = typeof WebSocket !== 'undefined';
  var demoMode = false, demoTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);

  /** @param {boolean} on @param {string} msg */
  function setState(on, msg) {
    var dot = $('w-dot'), state = $('w-state'), m = $('w-msg');
    if (!dot || !state || !m) return;
    dot.className = 'dot ' + (on ? 'on' : 'off');
    state.textContent = on ? 'LIVE' : 'off';
    state.style.color = on ? 'var(--ok)' : 'var(--bad)';
    m.innerHTML = msg;
  }

  /** @param {string} s */
  function log(s) {
    if (logged === 0) logEl.innerHTML = '';
    var d = document.createElement('div');
    d.textContent = s;
    logEl.insertBefore(d, logEl.firstChild);
    logged++;
    while (logEl.childNodes.length > 40) logEl.removeChild(/** @type {ChildNode} */ (logEl.lastChild));
  }

  function tick() {
    /** @type {HTMLElement} */ ($('w-served')).textContent = String(served);
    /** @type {HTMLElement} */ ($('w-inflight')).textContent = String(inflight);
  }

  /* The hub address. On the original this is /minter/ws on its own origin.
   * The session cookie is HttpOnly and SameSite=Lax: it rides along only when
   * the socket is the page's own origin, which is the default. If GLM_HUB_URL
   * points elsewhere, the hub will refuse the socket — sign in on that origin. */
  /** @returns {string} */
  function hubUrl() {
    if (win.GLM_HUB_URL) return win.GLM_HUB_URL;
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return proto + '://' + location.host + '/minter/ws';
  }

  /** @param {any} obj */
  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function startPings() {
    stopPings();
    pingTimer = setInterval(function () { send({ type: 'ping' }); }, PING_EVERY_MS);
  }
  function stopPings() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  /* ---------- 3. mint jobs ---------- */

  /** @param {string | undefined} id @param {MintJob} payload */
  function handleJob(id, payload) {
    inflight++; tick();
    var t0 = Date.now();
    var finish = function () { inflight--; tick(); };

    // MINT-ONLY page: refuse anything that is not a mint job, exactly like
    // the original page guards itself even though the hub wouldn't send it.
    var p;
    if (!payload || !payload.mint) {
      p = Promise.reject(new Error('minter page: non-mint job refused'));
    } else if (win.GLM && typeof GLM.mintCaptchaSerialized === 'function') {
      p = Promise.resolve().then(GLM.mintCaptchaSerialized);
    } else {
      p = Promise.reject(new Error('glm-client.js failed to load'));
    }

    p.then(function (param) {
      send({ type: 'captcha', id: id, param: param });
      served++;
      log('✓ captcha mint · ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
      finish();
    }).catch(function (e) {
      failed++;
      send({
        type: 'error', id: id, kind: 'upstream',
        detail: (e && e.message) || String(e),
        code: (e && e.code) || 502
      });
      log('✗ captcha mint · ' + ((e && e.message) || e));
      finish();
    });
  }

  /* ---------- the connection loop ---------- */

  function connect() {
    if (!wsSupported) { enterDemo('no WebSocket support'); return; }
    if (ws) { try { ws.close(); } catch (e) {} }

    /** @type {WebSocket} */ var socket;
    try { socket = new WebSocket(hubUrl()); }
    catch (e) { enterDemo('bad hub URL'); return; }
    ws = socket;

    socket.onopen = function () {
      everOpened = true;
      exitDemo();
      backoff = 800;
      setState(true, '<b style="color:var(--ok)">Connected.</b> Minting captchas for the pool. Thanks!');
      fetchPublicIp().then(function (ip) { send({ type: 'hello', ip: ip, proto: PROTO }); });
      startPings();
    };

    socket.onmessage = function (ev) {
      /** @type {HubMessage} */ var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'ping') { send({ type: 'pong' }); return; }
      if (msg.type === 'pong') return;
      if (msg.type === 'job') handleJob(msg.id, msg.payload);
    };

    socket.onclose = function () {
      stopPings();
      if (everOpened) {
        // a real hub connection was lost: reconnect like the original
        setState(false, 'Disconnected — reconnecting…');
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 1.7, 15000);
      } else {
        // the socket never opened. Two different reasons look identical here
        // (a refused handshake and a missing hub both just "close"), so ask
        // the hub's public half over HTTP and decide on facts, not guesses.
        probeHub(function (hubState) {
          if (hubState === 'refused') {
            // a hub IS listening and answered in JSON — it just won't take
            // this browser without a session. Saying "no hub" or silently
            // demo-minting would hide that, so say what to do.
            setState(false, '<b style="color:var(--bad)">Refused by the hub.</b> A session is ' +
              'required to mint now — <a href="login.html" style="color:var(--acc)">sign in</a> ' +
              'and this page will connect on its next try.');
            log('· the hub refused the socket: sign in, and it retries');
            refuseTimer = setTimeout(connect, 10000);
          } else {
            enterDemo('hub unreachable');
          }
        });
      }
    };
    socket.onerror = function () { try { socket.close(); } catch (e) {} };
  }

  /** @returns {Promise<string>} */
  function fetchPublicIp() {
    // Same rule as roles.js: the hub says where to look, the captured
    // original is the default when no hub answers.
    var url = win.GLM_IP_LOOKUP_URL || 'https://api.ipify.org?format=json';
    var ready = win.GLM_IP_LOOKUP_URL
      ? Promise.resolve(url)
      : fetch('/config', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          return (j && j.deploy && j.deploy.ipLookup) || url;
        })
        .catch(function () { return url; });
    return ready.then(function (where) {
      if (!where) return '';
      return fetch(where, { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) { return (j && j.ip) || ''; })
        .catch(function () { return ''; });
    });
  }

  /* Ask the hub's public half. Distinguishes "no hub at all" (static host or
   * another server) from "a hub is here and answered in JSON" — the refused
   * socket case. When this runs we are unauthenticated, so only /status/self's
   * 401 shape matters: JSON with an error about a session is a hub refusing
   * us; HTML or a network failure is no hub. */
  /** @param {(state: 'ok' | 'refused' | 'none') => void} cb */
  function probeHub(cb) {
    var base = '';
    if (win.GLM_HUB_URL) {
      try { base = new URL(win.GLM_HUB_URL).origin; } catch (e) { base = ''; }
    } else {
      base = location.origin;
    }
    fetch(base + '/status/self', { credentials: 'same-origin' })
      .then(function (r) {
        var ct = r.headers.get('content-type') || '';
        if (ct.indexOf('json') === -1) return cb('none');      // a static host
        return r.json().then(function (d) {
          // Signed in already? Then the refusal wasn't about us; try again.
          if (d && d.ok) return cb('ok');
          cb('refused');                                        // the hub's 401
        }, function () { cb('none'); });
      })
      .catch(function () { cb('none'); });
  }

  /* ---------- demo pool (no-hub fallback) ----------
   * Jobs spaced 20–45 s apart with random jitter, so mint activity is
   * spread evenly over time instead of arriving in bursts. */

  /** @param {string} reason */
  function enterDemo(reason) {
    if (demoMode) return;
    demoMode = true;
    stopPings();
    setState(true, '<b style="color:var(--ok)">Connected.</b> Minting captchas for the pool. Thanks!');
    log('· no hub at ' + (location.host || 'this host') + '/minter/ws (' + reason + ') — local demo pool');
    /** @type {() => void} */ var nextJob = function () {
      var wait = 20000 + Math.random() * 25000; // 20–45 s between jobs
      demoTimer = setTimeout(function () {
        handleJob('demo-' + Math.random().toString(36).slice(2, 8), { mint: true });
        if (demoMode) nextJob();
      }, wait);
    };
    nextJob();

    // keep probing for a real hub in the background
    hubProbeTimer = setInterval(function () {
      if (!demoMode) { clearInterval(/** @type {number} */ (hubProbeTimer)); return; }
      connect();
    }, HUB_RETRY_WHEN_DEMO_MS);
  }

  function exitDemo() {
    if (!demoMode) return;
    demoMode = false;
    if (demoTimer) { clearTimeout(demoTimer); demoTimer = null; }
    if (hubProbeTimer) { clearInterval(hubProbeTimer); hubProbeTimer = null; }
  }

  /* ---------- boot ---------- */

  // fill the egress IP line (same source the original uses)
  fetchPublicIp().then(function (ip) {
    /** @type {HTMLElement} */ ($('w-ip')).textContent = ip || '(could not detect)';
  });

  if (!win.GLM) {
    setState(false, 'glm-client.js failed to load');
  } else {
    connect();
  }
})();
