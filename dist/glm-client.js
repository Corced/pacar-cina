/* glm-client.js — clean-room rebuild of the minter page's captcha client.
 *
 * What the original does (observed in capture/how-it-works.md):
 *   - exposes a global `GLM` object
 *   - mintCaptchaSerialized(): loads the Aliyun captcha SDK, runs it in a
 *     hidden off-screen container, resolves with a serialized captcha param
 *   - the minter page then ships that param back to the hub over WebSocket
 *
 * This rebuild keeps that shape. The real Aliyun SDK needs a scene config
 * from the upstream site plus its live endpoints, so this file has two modes:
 *
 *   1. REAL mode — the scene comes from GET /config on the hub that served
 *      this page ({scene, prefix, region, lang, sdkUrl}), which the hub fills
 *      from its environment with the captured originals as defaults. An
 *      embedder that sets window.GLM_MINT_SCENE first overrides that. The SDK
 *      is then loaded and the widget runs hidden, as the original page does.
 *   2. DEMO mode — no hub answered (a plain static host): it simulates one
 *      mint cycle with a realistic duration, so the page can still be
 *      exercised. It says so; it never pretends to have minted for real.
 *
 * Nothing here talks to any upstream until REAL mode is configured.
 */
(function () {
  'use strict';

  var SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
  var OFFSCREEN_STYLE = 'position:absolute;left:-99999px;top:-99999px;width:0;height:0;overflow:hidden;pointer-events:none';
  var MINT_TIMEOUT_MS = 45000;

  /* Where the widget's settings come from, in order:
   *   1. window.GLM_MINT_SCENE — an embedder that pins the scene itself wins.
   *   2. GET /config on this origin — the hub's answer, which is env-driven
   *      server-side and falls back to the captured original values.
   *   3. nothing — the page keeps working in demo mode rather than pretending.
   * So a static deploy with no hub behaves exactly as before (demo), and a hub
   * deploy runs the real widget with whatever the operator configured. */
  var configPromise = null;

  function loadConfig() {
    if (configPromise) return configPromise;
    if (window.GLM_MINT_SCENE && window.GLM_MINT_SCENE.scene) {
      var pinned = {
        scene: window.GLM_MINT_SCENE.scene,
        prefix: window.GLM_MINT_SCENE.prefix,
        region: window.GLM_MINT_SCENE.region || 'sgp',
        lang: window.GLM_MINT_SCENE.lang || 'en',
        sdkUrl: window.GLM_MINT_SCENE.sdkUrl || SDK_URL,
        from: 'window.GLM_MINT_SCENE',
      };
      if (pinned.scene && pinned.prefix) { configPromise = Promise.resolve(pinned); return configPromise; }
    }
    var base = HUB_BASE();
    configPromise = fetch(base + '/config', { headers: { accept: 'application/json' } })
      .then(function (r) {
        var ct = r.headers.get('content-type') || '';
        if (ct.indexOf('json') === -1) throw GLMError('not a hub');
        return r.json();
      })
      .then(function (d) {
        if (!d || !d.captcha || !d.captcha.scene || !d.captcha.prefix) return null;
        return {
          scene: d.captcha.scene,
          prefix: d.captcha.prefix,
          region: d.captcha.region || 'sgp',
          lang: d.captcha.lang || 'en',
          sdkUrl: d.captcha.sdkUrl || SDK_URL,
          from: 'hub /config',
        };
      })
      .catch(function () { return null; });   // no hub: demo mode, as before
    return configPromise;
  }

  // The origin this script came from, so /config is asked of the page's hub
  // and never of some other host.
  function HUB_BASE() {
    if (window.GLM_HUB_URL) return String(window.GLM_HUB_URL).replace(/\/$/, '');
    return '';
  }


  function GLMError(message, code) {
    var e = new Error(message);
    e.name = 'GLMError';
    e.code = code || 502;
    return e;
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function jitter(minSec, maxSec) {
    return Math.round((minSec + Math.random() * (maxSec - minSec)) * 1000);
  }

  /* ---- hidden-element plumbing (mirrors the observed DOM behaviour) ---- */

  function ensureEls() {
    var el = document.getElementById('glm-captcha-el');
    if (!el) {
      el = document.createElement('div');
      el.id = 'glm-captcha-el';
      el.setAttribute('style', OFFSCREEN_STYLE);
      document.body.appendChild(el);
    }
    var btn = document.getElementById('glm-captcha-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'glm-captcha-btn';
      btn.setAttribute('aria-hidden', 'true');
      btn.setAttribute('style', 'position:absolute;left:-99999px;top:-99999px;width:1px;height:1px;opacity:0');
      document.body.appendChild(btn);
    }
    return { el: el, btn: btn };
  }

  function loadSdk(url) {
    return new Promise(function (resolve, reject) {
      if (window.initAliyunCaptcha) return resolve();
      var s = document.createElement('script');
      s.src = url || SDK_URL;
      s.onload = function () {
        if (window.initAliyunCaptcha) resolve();
        else reject(GLMError('initAliyunCaptcha missing after SDK load'));
      };
      s.onerror = function () { reject(GLMError('Aliyun SDK load failed')); };
      document.head.appendChild(s);
    });
  }

  /* ---- REAL mode: run the widget hidden and resolve the param ---- */

  function mintCaptcha(scene) {
    return new Promise(function (resolve, reject) {
      var els = ensureEls();
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; reject(GLMError('captcha mint timeout')); }
      }, MINT_TIMEOUT_MS);

      loadSdk(scene.sdkUrl).then(function () {
        try {
          window.initAliyunCaptcha({
            SceneId: scene.scene,
            prefix: scene.prefix,
            mode: 'popup',
            element: '#' + els.el.id,
            button: '#' + els.btn.id,
            region: scene.region || 'sgp',
            language: scene.lang || 'en',
            captchaVerifyCallback: function (param) {
              if (done) return;
              done = true;
              clearTimeout(timer);
              resolve(param);
            },
            onBizResultCallback: function () {},
            getInstance: function (i) { els.instance = i; },
            slideStyle: { width: 320, height: 40 },
            language: scene.lang || 'en',
          });
        } catch (e) {
          if (!done) { done = true; clearTimeout(timer); reject(GLMError('captcha fail: ' + (e && e.message ? e.message : e))); }
        }
      }).catch(function (e) {
        if (!done) { done = true; clearTimeout(timer); reject(e); }
      });
    });
  }

  /* ---- DEMO mode: a simulated mint cycle (no upstream calls) ---- */

  function mintCaptchaSimulated() {
    ensureEls(); // keep the same hidden DOM in place
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve({
          captchaVerifyParam: 'sim:' + uuid(),
          demo: true,
        });
      }, jitter(1.4, 3.8)); // realistic mint duration, jittered
    });
  }

  /* ---- public surface (what the minter page calls) ---- */

  function mintCaptchaSerialized() {
    return loadConfig().then(function (scene) {
      if (scene && scene.scene && scene.prefix) {
        return mintCaptcha(scene).then(function (param) {
          return JSON.stringify(param);
        });
      }
      return mintCaptchaSimulated().then(function (param) {
        return JSON.stringify(param);
      });
    });
  }

  window.GLM = {
    version: '0.1.0-cleanroom',
    uuid: uuid,
    mintCaptcha: mintCaptcha,
    mintCaptchaSerialized: mintCaptchaSerialized,
    GLMError: GLMError,
  };
})();
