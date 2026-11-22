// @ts-check
/* chat.js — talk to the model through this hub, from the browser.
 *
 * Plain ES5 the browser runs as-is: the `@ts-check` line and the JSDoc below are
 * comments to it, and `npm run check` type-checks them with `tsc` when one is on
 * PATH. There is no build step and never will be one here.
 *
 * Two states, the same as every other page here: a hub answers the OpenAI-shaped
 * endpoints, or this origin is static and answers something else. A reply is
 * shown only when a reply arrived; a refusal is quoted rather than smoothed
 * over; and a turn that got no answer goes back into the composer instead of
 * sitting in the transcript pretending it was sent.
 *
 * The transcript is memory only. No message text is written to local storage or
 * anywhere else on this machine, so a reload starts clean while the hub keeps
 * the conversation it already relayed.
 */
(function () {
  'use strict';

  /** One line of the conversation: exactly what the hub is sent and returns. */
  /** @typedef {{ role: 'user' | 'assistant', content: string }} Turn */

  /** One entry of GET /v1/models — the page only reads these three fields. */
  /** @typedef {{ id: string, meta?: { source?: string, base?: string, features?: string[] } }} CatalogModel */

  /** A finished exchange: the response plus the send-time facts the page needs. */
  /** @typedef {{
   *   status: number,
   *   h: Headers,
   *   j: any,
   *   raw: string,
   *   node: HTMLElement | null,
   *   body: string,
   *   model: string,
   *   sentId: string | null
   * }} Exchange */

  /** window plus the two things this page puts on it. */
  /** @typedef {Window & { GLM_HUB_URL?: string, CHAT?: { mount: () => void } }} ChatWindow */

  var win = /** @type {ChatWindow} */ (/** @type {unknown} */ (window));
  var HUB = (win.GLM_HUB_URL || '').replace(/\/$/, '');

  /** @type {string | null} */ var chatId = null;  // x-glm-chat — the id the hub minted, handed back next turn
  /** @type {Turn[]} */ var history = [];         // exactly what is on screen
  var busy = false;                                // one request at a time
  var until = 0;                                   // cooldown end, ms
  /** @type {ReturnType<typeof setInterval> | null} */ var ticker = null;

  /** @param {string} id @returns {HTMLElement | null} */
  function $(id) { return document.getElementById(id); }
  /** @param {string} id @returns {HTMLInputElement | null} */
  function input(id) { return /** @type {HTMLInputElement | null} */ ($(id)); }
  /** @param {string} id @returns {HTMLSelectElement | null} */
  function select(id) { return /** @type {HTMLSelectElement | null} */ ($(id)); }
  /** @param {string} id @returns {HTMLButtonElement | null} */
  function button(id) { return /** @type {HTMLButtonElement | null} */ ($(id)); }

  /** @param {string} id @param {unknown} v */
  function text(id, v) {
    var el = $(id);
    if (!el) return;
    el.textContent = (v === null || v === undefined || v === '') ? '—' : String(v);
  }

  // The last 8 characters are enough to tell two ids apart on screen.
  /** @param {string | null | undefined} id @returns {string | null} */
  function short(id) { return id ? String(id).slice(-8) : null; }

  /** @param {string} msg @param {'bad' | 'warn' | 'ok' | 'mut'} [kind] */
  function say(msg, kind) {
    var el = $('said');
    if (!el) return;
    el.textContent = msg;
    el.style.color = kind === 'bad' ? 'var(--bad)'
      : kind === 'warn' ? 'var(--warn)'
      : kind === 'ok' ? 'var(--ok)' : 'var(--mut)';
  }

  /** @param {string | null} v @param {'bad'} [kind] */
  function lastErr(v, kind) {
    var el = $('s-err');
    if (!el) return;
    el.textContent = v || 'none';
    el.className = kind === 'bad' ? 'bad' : '';
  }

  /* The button carries the state: sending, cooling down, or ready. */
  function paint() {
    var send = button('send');
    var nc = button('newchat');
    var wait = Math.ceil((until - Date.now()) / 1000);
    if (send) {
      if (busy) { send.disabled = true; send.textContent = 'Sending…'; }
      else if (wait > 0) { send.disabled = true; send.textContent = 'Send (' + wait + 's)'; }
      else { send.disabled = false; send.textContent = 'Send'; }
    }
    if (nc) nc.disabled = busy;   // no clearing the id while a turn is in flight
  }

  /** @param {number} secs */
  function cool(secs) {
    var s = Math.max(0, Number(secs) || 0);
    until = Date.now() + s * 1000;
    paint();
    if (ticker || !s) return;
    var t = setInterval(function () {
      paint();
      if (Date.now() >= until) { clearInterval(t); ticker = null; paint(); }
    }, 500);
    ticker = t;
  }

  /* ── transcript ─────────────────────────────────────────────── */

  function emptyHint() {
    var p = document.createElement('p');
    p.className = 'hint';
    p.id = 'empty';
    p.style.margin = '0';
    p.textContent = 'Nothing yet. The first turn starts a conversation and the hub returns its id.';
    return p;
  }

  function clearTranscript() {
    var box = $('chat');
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    box.appendChild(emptyHint());
  }

  /** @param {string} label @param {string} body @param {string} cls
   *  @returns {HTMLElement | null} */
  function turn(label, body, cls) {
    var box = $('chat');
    if (!box) return null;
    var empty = $('empty');
    if (empty && empty.parentNode) empty.parentNode.removeChild(empty);
    var wrap = document.createElement('div');
    wrap.className = 'turn ' + cls;
    var head = document.createElement('div');
    head.className = 'trole';
    head.textContent = label;
    var txt = document.createElement('div');
    txt.className = 'txt';
    txt.textContent = body;
    wrap.appendChild(head);
    wrap.appendChild(txt);
    box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;
    return wrap;
  }

  /* A turn that was not answered is taken back out: the hub rolled its history
     back the same way, so what this page sends next matches what the hub holds. */
  /** @param {HTMLElement | null} node @param {string} body */
  function release(node, body) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
    if (history.length && history[history.length - 1].role === 'user') history.pop();
    var box = input('msg');
    if (box && !box.value.trim()) box.value = body;
    var chat = $('chat');
    if (chat && !chat.firstChild) chat.appendChild(emptyHint());
  }

  /** @param {boolean} on */
  function showRecover(on) {
    var el = $('recover');
    if (el) el.hidden = !on;
  }

  /* ── the catalog ────────────────────────────────────────────── */

  /** @param {string[] | undefined} features @returns {string} */
  function featureWords(features) {
    /** @type {Record<string, string>} */
    var names = { thinking: 'thinking', web_search: 'web search', deep_research: 'deep research' };
    if (!features || !features.length) return '';
    return features.map(function (f) { return names[f] || f; }).join(' + ');
  }

  function loadModels() {
    fetch(HUB + '/v1/models', { headers: { accept: 'application/json' } })
      .then(function (r) {
        return r.text().then(function (t) {
          /** @type {any} */ var j = null;
          try { j = JSON.parse(t); } catch (e) { /* not the hub's JSON */ }
          return { status: r.status, j: j };
        });
      })
      .then(function (o) {
        var list = o.j && o.j.data;
        if (o.status !== 200 || !list || !list.length) {
          throw new Error(o.status === 200 ? 'the list was empty' : 'HTTP ' + o.status);
        }
        fillModels(list);
      })
      .catch(function (e) {
        typedModel('The catalog could not be listed (' + (e instanceof Error ? e.message : String(e))
          + '), so the picker is a text box: '
          + 'type an id such as z.ai/glm-5.3 and the hub will resolve it. A base it has never seen '
          + 'still forwards when it starts with glm.');
      });
  }

  /** @param {string} why */
  function typedModel(why) {
    var sel = select('model');
    var free = input('modelfree');
    var note = $('modelnote');
    if (sel) sel.hidden = true;
    if (free) { free.hidden = false; if (!free.value) free.value = 'z.ai/glm-5.3'; }
    if (note) note.textContent = why;
  }

  /** @param {CatalogModel[]} list */
  function fillModels(list) {
    var sel = select('model');
    var note = $('modelnote');
    if (!sel) return;

    /** @type {Record<string, CatalogModel[]>} */ var bySource = {};
    /** @type {string[]} */ var order = [];
    list.forEach(function (m) {
      var src = (m.meta && m.meta.source) || 'other';
      if (!bySource[src]) { bySource[src] = []; order.push(src); }
      bySource[src].push(m);
    });

    // The proof of non-null has to leave the guard's scope: the callbacks below
    // are separate functions as far as the checker is concerned.
    var picker = /** @type {HTMLSelectElement} */ (sel);
    while (picker.firstChild) picker.removeChild(picker.firstChild);
    order.forEach(function (src) {
      var group = document.createElement('optgroup');
      group.label = src === 'z.ai' ? 'z.ai — chat.z.ai (overseas)'
        : src === 'cn' ? 'cn — chatglm.cn'
        : src;
      bySource[src].forEach(function (m) {
        var opt = document.createElement('option');
        opt.value = m.id;
        var base = (m.meta && m.meta.base) || m.id;
        var feats = featureWords(m.meta && m.meta.features);
        opt.textContent = base + (feats ? ' · ' + feats : '');
        group.appendChild(opt);
      });
      picker.appendChild(group);
    });

    var wanted = list.some(function (m) { return m.id === 'z.ai/glm-5.3'; })
      ? 'z.ai/glm-5.3' : list[0].id;
    sel.value = wanted;

    if (note) {
      note.textContent = list.length + ' ids from two sources: z.ai/ goes to chat.z.ai, cn/ to '
        + 'chatglm.cn. A suffix — -think, -search, -deepresearch — is a feature the catalog '
        + 'declares, not one this page can prove the far end honours. A base the catalog never '
        + 'heard of still forwards when it starts with glm.';
    }
  }

  /** @returns {string} */
  function modelId() {
    var free = input('modelfree');
    if (free && !free.hidden) return free.value.trim();
    var sel = select('model');
    return sel ? sel.value : '';
  }

  /* ── one turn ───────────────────────────────────────────────── */

  /** @param {any} j @returns {string} */
  function replyText(j) {
    try {
      var c = j.choices[0].message.content;
      if (typeof c === 'string') return c;
      if (c && c.length) {
        return c.map(function (/** @type {any} */ p) { return typeof p === 'string' ? p : (p && p.text) || ''; }).join('');
      }
    } catch (e) { /* not the shape this page reads */ }
    return '';
  }

  /** @param {Exchange} o */
  function paintStrip(o) {
    text('s-chat', short(chatId));
    text('s-caller', o.h.get('x-glm-caller'));
    text('s-pool', o.h.get('x-glm-pool'));
    var k = o.h.get('x-glm-model-known');
    text('s-known', k === 'true' ? 'yes' : k === 'false' ? 'unknown' : null);
  }

  function send() {
    if (busy || Date.now() < until) return;
    var box = input('msg');
    var body = box ? box.value.trim() : '';
    if (!body) {
      say('Nothing to send — type a message first.', 'warn');
      lastErr('empty turn', 'bad');
      return;
    }
    var model = modelId();
    if (!model) {
      say('No model id: the picker is empty. Name one — for example z.ai/glm-5.3 — or reload so the catalog can be listed.', 'bad');
      lastErr('no model', 'bad');
      return;
    }

    var sentId = chatId;
    var node = turn('you', body, 'me');
    history.push({ role: 'user', content: body });
    if (box) box.value = '';
    busy = true;
    paint();
    say('Waiting for the hub…', 'mut');
    lastErr('none');

    /** @type {{ model: string, messages: Turn[], stream: boolean, chat_id?: string }} */
    var payload = { model: model, messages: history.slice(), stream: false };
    if (chatId) payload.chat_id = chatId;

    fetch(HUB + '/v1/chat/completions', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        return r.text().then(function (t) {
          /** @type {any} */ var j = null;
          try { j = JSON.parse(t); } catch (e) { /* not JSON: probably not the hub */ }
          /** @type {Exchange} */
          var out = { status: r.status, h: r.headers, j: j, raw: t, node: node, body: body, model: model, sentId: sentId };
          return out;
        });
      })
      .then(done)
      .catch(function () {
        release(node, body);
        busy = false;
        paint();
        say('No hub on this origin — nothing was sent. The message is back in the box.', 'bad');
        lastErr('no hub', 'bad');
      });
  }

  /** @param {Exchange} o */
  function done(o) {
    busy = false;
    paint();

    var h = o.h;
    var j = o.j;
    var forwarded = !!(h.get('x-glm-chat') || h.get('x-glm-pool'));
    var isHub = forwarded || !!(j && typeof j === 'object');
    var source = (j && j.error) || {};
    var msg = typeof source === 'string' ? source : (source.message || '');
    var type = typeof source === 'string' ? '' : (source.type || '');

    if (!isHub) {
      release(o.node, o.body);
      say('No hub on this origin, so nothing was sent: the request answered HTTP ' + o.status
        + ' with something that is not the hub\'s JSON. A static host has no chat endpoint to talk to.', 'bad');
      lastErr('no hub', 'bad');
      return;
    }

    // The id survives every refusal except a 404, where the page asks first.
    if (h.get('x-glm-chat')) chatId = h.get('x-glm-chat');

    if (o.status === 200) {
      paintStrip(o);
      var reply = replyText(j);
      if (!reply) {
        release(o.node, o.body);
        say('The hub answered 200 but the body held no assistant message this page can read, so the '
          + 'turn is not kept here. The hub keeps a reply only when it can read one too, so the two '
          + 'sides agree.', 'bad');
        lastErr('200 · unreadable body', 'bad');
        return;
      }
      history.push({ role: 'assistant', content: reply });
      turn('assistant · ' + o.model, reply, 'bot');

      var bits = [];
      var cont = h.get('x-glm-chat-continued');
      if (cont === 'true') bits.push('the hub continued this conversation');
      else if (cont === 'false') bits.push('the hub did not continue the id that was sent — this turn started a new one');
      if (h.get('x-glm-model-known') === 'false') {
        bits.push('the catalog never heard of this base and the hub forwarded it anyway, which it allows '
          + 'for any glm base');
      }
      say(bits.length ? 'Reply received — ' + bits.join('; ') + '.' : 'Reply received.', 'ok');
      lastErr('none');
      return;
    }

    paintStrip(o);
    release(o.node, o.body);

    if (o.status === 501) {
      say('The hub resolved ' + (source.resolved_model || o.model) + ' but has no GLM_UPSTREAM set, so '
        + 'there is nowhere to forward the turn. Nothing was retried. Hub: "' + (msg || 'not implemented') + '".', 'bad');
      lastErr('501 · no upstream', 'bad');
      return;
    }

    if (o.status === 429) {
      var secs = Number(source.retry_after_seconds);
      if (!(secs > 0)) secs = 5;
      cool(secs);
      say('Refused: this caller already holds ' + (source.limit || 4) + ' requests in flight, or is still '
        + 'cooling down. The send button stays off for ' + secs + 's and counts down; nothing is resent for '
        + 'you. Hub: "' + (msg || 'rate limited') + '".', 'bad');
      lastErr('429 · wait ' + secs + 's', 'bad');
      return;
    }

    if (o.status === 409) {
      say('This conversation already has a turn in flight — the hub refused this one so two answers cannot '
        + 'overwrite each other (409 chat_busy). Wait for the answer already running, then send. '
        + 'Nothing was resent.', 'bad');
      lastErr('409 · chat busy', 'bad');
      return;
    }

    if (o.status === 404 && type === 'chat_not_found') {
      showRecover(true);
      say('The hub does not have conversation ' + (short(o.sentId) || 'this one') + ' any more: a restart '
        + 'forgets every id, and the oldest is evicted once 200 exist. The id is kept on screen — press '
        + '"Start a fresh conversation" to drop it and begin again. ' + (msg ? 'Hub: "' + msg + '".' : ''), 'bad');
      lastErr('404 · conversation gone', 'bad');
      return;
    }

    if (o.status === 400) {
      showRecover(false);
      say('The hub refused the model id. ' + (msg || 'HTTP 400 with no message.'), 'bad');
      lastErr('400 · unknown model', 'bad');
      return;
    }

    if (o.status === 502) {
      say('The upstream was unreachable, so no reply came back. '
        + (msg || 'The hub did not say why.') + ' The hub kept the pool entry, so no minted param was spent.', 'bad');
      lastErr('502 · upstream unreachable', 'bad');
      return;
    }

    // Everything else, including a non-200 the hub forwarded verbatim from upstream.
    var detail = msg || String(o.raw || '').slice(0, 300) || 'no body';
    say('HTTP ' + o.status + '. ' + detail, 'bad');
    lastErr('HTTP ' + o.status, 'bad');
  }

  /* ── the buttons ────────────────────────────────────────────── */

  function newChat() {
    var had = chatId;
    chatId = null;
    history.length = 0;
    clearTranscript();
    showRecover(false);
    text('s-chat', null);
    text('s-caller', null);
    text('s-pool', null);
    text('s-known', null);
    lastErr('none');
    say(had
      ? 'New conversation. The old id (' + short(had) + ') was dropped here on purpose; the hub still holds '
        + 'it until it is evicted.'
      : 'New conversation. The transcript is empty; the next turn starts one on the hub.', 'mut');
  }

  function mount() {
    var sendBtn = button('send');
    if (sendBtn) sendBtn.addEventListener('click', send);

    var nc = button('newchat');
    if (nc) nc.addEventListener('click', newChat);

    var rec = button('recover');
    if (rec) rec.addEventListener('click', newChat);

    // Enter is a newline; Ctrl/Cmd+Enter is the send. Typed, not toggled.
    var box = input('msg');
    if (box) {
      box.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
      });
    }

    paint();
    loadModels();
  }

  win.CHAT = { mount: mount };
})();