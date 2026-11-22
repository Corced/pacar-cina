# public/

## Responsibility

The whole published site: seven HTML pages, six scripts, four stylesheets. Plain
HTML/CSS/JS, no bundler, no imports, no build step beyond a verbatim copy —
`build.mjs` copies this directory to `dist/` and fails if server code leaks in.
Each page is a self-contained document that loads shared scripts with `<script
src>` and calls a namespace it exposes on `window`.

This is the *partner surface* of the project: the minter tab partners keep open,
the chat page every signed-in role uses, the sign-in front door, the two "lend
something" pages, the operator panel, and a reference-projects write-up.

## Design

**IIFE modules with a global namespace.** Every script is `(function(){…})()`
(strict mode) and exposes at most one global: `window.GLM` with
`mintCaptchaSerialized()` from `glm-client.js`, `window.ROLES` with `{role,
mountLogin, mountPartner, arm, log}` from `roles.js`, `window.CHAT` (`mount`) from
`chat.js`, `window.USER` (`mount`) from `user.js`. `minter.js` and `admin.js` are
page-scoped and expose nothing. No ES modules, so a page can be opened as a
plain file.

**Dual mode: hub or static, never faked.** Every script probes for a hub and
branches:

- `roles.js hub()` → `GET /session`, content-type must be JSON, cached once.
- `admin.js refresh()` → `GET /status`, the same content-type tell.
- `chat.js loadModels()` → `GET /v1/models`; a non-JSON body switches the model
  picker to a typed id instead of leaving an empty select.
- `user.js poll()` → `GET /status/self`; every figure goes back to a dash and the
  page says why when the hub cannot answer.
- `glm-client.js loadConfig()` → `GET /config`.
- `minter.js` → socket open/refused, then `GET /status/self` to distinguish
  "hub refused you" from "no hub here".

With a hub the real path runs. Without one the page falls into a *labelled*
demo mode — `glm-client.js` simulates a mint cycle, `minter.js` runs a local
demo pool with 20–45 s jittered jobs and keeps retrying the hub every 30 s,
`admin.js` shows `-` placeholders. Nothing claims a mint happened when it did
not; that rule is asserted by the check suites (HANDOFF trap 7).

**Server-injected navigation.** Each page except `login.html` carries a literal
`<!--nav-->` marker where the bar belongs. The marker is an HTML comment, so it
renders as nothing on a static host; `hub.mjs`'s `withNav` replaces it with
role-specific links at serve time. Consequence: the nav is correct in the first
paint and no script can show the wrong menu — and hiding a link is never an
access check.

**Design tokens in one file.** `minter.css` defines the recorded GitHub-dark
palette (`--bg #0d1117`, `--fg #e6edf3`, `--acc #2ea043`), the `.card` /
`.stat` / `.warnbox` / `.dot` primitives and the nav bar. The other three
stylesheets only add per-page layout: `role.css` (login/user/partner/chat),
`admin.css` (panel grid), `repos.css` (long-form comparison page).

**Background-tab keep-alive.** Both `minter.js` and `roles.js` arm a silent
AudioContext oscillator (30 Hz, gain 0.01) on the first pointer/touch/key/click
gesture. Until it is armed a red box asks for a tap; after, it turns green. The
technique is reproduced from the original page; that it actually prevents
throttling is unverified.

**Single-file mint client.** `glm-client.js` owns the Aliyun widget: config
resolution order `window.GLM_MINT_SCENE` → `GET /config` → nothing (demo);
`loadSdk` injects `AliyunCaptcha.js` once and waits for `window.initAliyunCaptcha`;
`ensureEls` creates off-screen `#glm-captcha-el` and a hidden `#glm-captcha-btn`;
a `MINT_TIMEOUT_MS` (45 s) guard rejects a hung widget.

## Flow

**minter.js** (index.html). Connection is a state machine: `connect()` →
`new WebSocket(hubUrl())` (`GLM_HUB_URL` or `ws(s)://<location.host>/minter/ws`)
→ `onopen`: `{type:'hello', ip, proto:2}` via the ipify lookup, state `LIVE`,
`startPings()` every 25 s → `onmessage`: `job` → `handleJob` → `inflight++`,
`GLM.mintCaptchaSerialized()` → `{type:'captcha', id, param}` or `{type:'error',
id, kind, detail}` with `inflight--` on both → `ping` → send `pong` → `bye` →
close. `onclose` reconnects with `backoff = 800 ms × 1.7`, capped at 15 s; a
`visibilitychange` to visible resets the socket if it is not OPEN. The activity
log is a DOM list capped at 40 nodes, newest first.

**glm-client.js**. `mintCaptchaSerialized()` = `loadConfig()` → if real config:
`loadSdk(sdkUrl)` → `mintCaptcha(scene)` (init the widget hidden, click the
hidden button, resolve the serialized param) ; else `demoMint()` resolving after
a realistic delay. Errors are `GLMError(message, code)` so `minter.js` can send
`kind:'upstream'` with a code.

**roles.js**. Page entrypoints: `mountLogin()`, `mountPartner()`. `mountLogin`
reads `?next=`, reveals a key box for partner/admin/superadmin, `signIn(role,
key)` → `POST /session {role, key}` → on 200 remembers the role in
`localStorage['glm2api.role']` and navigates to `loginNext(HOME[role])`. The role
cards are `<a>` elements, so the click handler calls `preventDefault()` first —
without it the browser follows the href, the hub bounces back to `login.html`,
and the key box never appears (that was a real bug; `check-html.mjs` trips on
the line going missing).
`mountPartner` posts the token form to `/tokens`, then polls `/tokens` and
`/tokens?mine=1` for contribution counts and per-donation statuses. It also
carries the compact "contribute an upstream token" block
(`POST /upstream/keys` and `/upstream/keys/revoke`, rows from
`/status/self.myKeys`): the input is `type="password"`, cleared on success, and
nothing about it is stored anywhere. `noHub()`
probes `/status/self` so the page can say whether a hub is actually there
(200 signed in, 401 hub without a session, anything else static) instead of
always claiming there is none.

**chat.js**. `mount()` fills the picker from `/v1/models` (grouped by
`meta.source`, features labelled as declared), then each `send()` POSTs the full
displayed history to `/v1/chat/completions` with `chat_id` when the hub has
minted one. One turn at a time: the send button is disabled while a request is in
flight and during a 429 cooldown countdown. `x-glm-chat` is kept across every
refusal except 404, where the id stays on screen and a "start fresh" button
clears it. A turn with no readable assistant reply goes back into the composer —
the hub rolls its own history back the same way, so the two sides stay in step.
The transcript is memory only.

**user.js**. `mount()` polls `GET /status/self` every 5 s and on
`visibilitychange`; renders `you` (address as the hub observed it, whether a
minter socket from it is connected, captchas that address returned) and
`poolNow` (tokens/in-flight/online/minted/failed). A failed poll blanks every
figure rather than leaving the previous one up. It carries the same compact
"contribute an upstream token" block as the partner page — the one contribution
every signed-in role can make.

**All six scripts are JSDoc-typed.** Each opens with `// @ts-check` and a
`@typedef` for the wire shape it reads (`Turn`/`CatalogModel`/`Exchange` in
`chat.js`, `Self`/`LastSeen` in `user.js`, `Status`/`Partner`/`Person`/
`Donation` in `admin.js`, `Scene`/`AliyunOptions`/`GlmClient` in
`glm-client.js`, `GlmClient`/`MintJob`/`HubMessage` in `minter.js`,
`HubProbe` in `roles.js`), plus `$`/`input()`/`select()`/`button()` accessors so
an input is an `HTMLInputElement`, not a bare `HTMLElement`. Nothing is
compiled: the
comments are comments to the browser, and `check-types.mjs` runs `tsc --strict`
over the files that opt in when a `tsc` is on PATH (skipping loudly when not).
Turning them on cleared 272 diagnostics across the six and found one real defect
— a duplicate `language` key in the Aliyun options. A new script joins by adding
the comment and its typedefs; untrusted JSON stays `any`, because the hub's
payloads are the contract, not the types.

**admin.js**. `refresh()` polls `/status` every 5 s → `fillStatus(d)` writes
every panel (including `chat.poolSpent`, the count of pool entries the chat path
has spent); `authState` drives the key box (`needKey()` on 401/403 → `grabKey()`
→ `POST /session`, trying `admin` then `superadmin` because only a superadmin
may create people); `fillPeople()` renders the directory with a Rotate/Revoke
button per row, disabled for anyone pinned by the environment; `createPerson()`
and `personAction()` post the mutations and show a new key exactly once;
`applyRoleGates()` disables the create controls for a plain admin;
`refreshDonations()` reads `/tokens?all=1`; toggles `POST /features`; the
clear-sessions button posts `/admin/session/clear`; `wrongRoleNote()` surfaces
`?wrongrole=`. Two panels were rewritten when the backend stopped pretending:
the **shared upstream tokens** panel renders `d.upstreamKeys` (counts, then rows
with health and a Revoke button; `contributeKey()` posts `/upstream/keys` and
prints the gate's own `checks` lines verbatim, clearing the password input on
success), and the **egress** panel is read-only from `d.egress` — mode, routes,
dead, the hub's `note`, and `lastError` in the warning colour. The four old
`[data-egress]` switches that flipped a label and posted nothing are gone;
`direct` renders neutral on purpose, because it is a state, not a fault.

**Pages.** `login.html`, `partner.html` and `user.html` are script-mounted
(`ROLES.mountLogin()`/`ROLES.mountPartner()`/`USER.mount()` inline after the
script tag); `chat.html` is `CHAT.mount()`; `index.html` is static markup
whose ids (`w-state`, `w-served`, `w-inflight`, `w-dot`, `w-msg`, `w-ip`,
`w-keep`, `wlog`) are the entire contract with `minter.js`; `admin.html` is a
large static skeleton filled by `admin.js` id-by-id; `repos.html` is pure
content, no script.

## Integration

| Page | Loads | Hub routes |
|---|---|---|
| `index.html` (minter) | `minter.css`, `minter.js` → needs `glm-client.js` global `GLM` | `WS /minter/ws`, `GET /config` (indirect), `GET /status/self`, ipify |
| `login.html` (front door) | `minter.css`, `role.css`, `roles.js` | `GET /session` (probe), `POST /session` |
| `chat.html` | `minter.css`, `role.css`, `chat.js` | `GET /v1/models`, `POST /v1/chat/completions` (headers `x-glm-chat`/`-caller`/`-pool`/`-model-known`/`-chat-continued`) |
| `user.html` | `minter.css`, `role.css`, `user.js` | `GET /status/self` (5 s) |
| `partner.html` | `minter.css`, `role.css`, `roles.js` | `GET /session`, `POST /tokens`, `GET /tokens`, `GET /tokens?mine=1` |
| `admin.html` | `minter.css`, `admin.css`, `admin.js` | `GET /status` (5 s), `POST /session`, `GET /tokens?all=1`, `POST /features`, `POST /admin/session/clear`, `POST /people`, `POST /people/revoke`, `POST /people/rotate` |
| Session counters | `/status` `activeSessions`, `expiredSessions`, `sessionTtlMs`; expiry is enforced in `readSession`, not by the cookie |
| `repos.html` | `minter.css`, `repos.css` | — (static content) |

Every page except `login.html` contains the `<!--nav-->` marker the hub fills.
`glm-client.js` is only loaded by the minter flow; a page that calls
`GLM.mintCaptchaSerialized()` without it gets the explicit
`'glm-client.js failed to load'` error rather than silence.

Outward calls made from the browser: the Aliyun SDK URL (`sdkUrl` from
`/config`), and the IP-lookup service (`GLM_IP_LOOKUP_URL` via `/config`,
default `api.ipify.org`). No other third party.
