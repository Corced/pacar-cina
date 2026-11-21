# glm2api · captcha minter — clean-room rebuild

A rebuild of the `/minter` page from `babsbsb-glm-worker.hf.space` — the page
partners keep open so their browsers mint Aliyun captcha solutions for a shared
pool — plus the backend it implied: a hub that spreads the mint work across
every connected browser, knows who is contributing, and refuses strangers.

Everything here was written from recordings of the original page and from
reading the source of three reference projects. Nothing was copied: no original
code, no logos, no long passages.

Written and maintained by **Corced**.

**Taking over the project?** Read [`HANDOFF.md`](HANDOFF.md) first — it explains
the system in one pass, states what is proven and what is not, and lists the
traps that have already caught someone. This file is the reference: every route,
every setting, the protocol in full. If you only want to start it and poke at it,
[`INSTRUCTION.md`](INSTRUCTION.md) is the one-page operator guide.

---

## Is the "session donation" finished?

**Yes for the part the whole project exists for — with honest edges.**
"Session donation" here means three different things, and they are in
different states:

| What is donated                                                                                            | State                                                                                                                                                                                                                                                                           | Proven by                                                                |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **A browser's mint work** - a partner keeps a tab open; the hub sends it captcha jobs; the browser answers | **Finished and proven.** Key-gated socket, real job round trip, even spread across partners, pool stops exactly at its target, entries expire and the pool refills itself; a graceful close takes the partner offline and frees a job it was holding instead of leaving it busy | `check-hub.mjs` (60 expectations) + `check-hub-multi.mjs` (9), all green |
| **Tokens / sessions pasted into `partner.html`**                                                           | **Accepted and verified on arrival.** The form POSTs to `POST /tokens`; the hub keeps only a SHA-256 fingerprint, checks the value with Aliyun straight away, and records valid / invalid / unverified — never the value                                                        | `check-hub.mjs` (donation expectations)                                  |
| **An IP as an egress point** (`user.html`)                                                                 | **Toggle only.** The switch is remembered, nothing routes traffic through it                                                                                                                                                                                                    | Stated on the page itself                                                |

So: open the hub, sign in as a partner, open the minter tab — that flow works
end to end today, and the values it runs on (captcha scene, appkey, FE version,
upstream origins, model list) come from the environment rather than the source.
Routing traffic through volunteer IPs is documented on its page as not-yet-real
rather than faked.

---

## Quick start

```bash
npm install          # nothing to install — zero dependencies (a lockfile only)
npm run build        # copies public/ into dist/
npm run hub          # starts the backend on http://127.0.0.1:5082
```

The hub prints its keys on start, e.g.:

```
  superadmin key (printed once): glm-superadmin-…
  partner key (generated this run): glm-partner-…
  admin key (generated this run): glm-admin-…
  set GLM_KEYS=partner:<key>,admin:<key> to keep a key across restarts
```

Then, in a browser:

1. Open `http://127.0.0.1:5082/` — with no session it redirects to
   `login.html`, and with one it goes to that role's own page. `/` is not the
   minter; the minter is `index.html`, one click away in the nav bar.
2. Sign in as **partner** with the partner key. You land on `partner.html`.
3. Click **minter** in the nav bar. `index.html` connects, shows **LIVE**, and
   starts receiving mint jobs from the hub.
4. For the operator view: sign in as **admin** with the admin key; you land on
   `admin.html`. It polls `/status` every 5 s and shows connected partners,
   their egress IPs, the pool count and the feature toggles.

Two browser profiles (or two machines) make steps 2 and 4 nicer, because the
session cookie is one role at a time per browser.

---

## The pages

| Page    | File                       | What it is                                                                                                                                                                                                                                                      |
| ------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Minter  | `index.html` + `minter.js` | The page a partner keeps open. Connects to `/minter/ws`, answers mint jobs, shows status/mints/in-flight and a 40-line activity log. This is a rebuild of the original page and keeps its exact contract.                                                       |
| Sign in | `login.html`               | **The front door.** `/` redirects here (or to your own page if you are already signed in). The three roles. **user** signs in with no key (open by design); **partner** and **admin** reveal a key box. Explains honestly what a session is and what it is not. |
| User    | `user.html`                | “Lend an IP”. Shows the egress IP the far end would see, uptime, captcha count, and the egress/solve/tab-only switches.                                                                                                                                         |
| Partner | `partner.html`             | “Lend accounts”. The token/session paste form (currently local-only), contribution counters, same minting ability as everyone.                                                                                                                                  |
| Admin   | `admin.html`               | The operator panel: status, partner pool (id, IP, role, mints, state), token pool, feature defaults, egress classes, endpoints, activity log, a key box on 401/403.                                                                                             |
| Repos   | `repos.html`               | A dissection of the three reference projects — what each has, what each lacks, and the gap none of them fills (a partner-facing page).                                                                                                                          |

All pages are narrow by design (minter 640 px, repos 700 px, admin 840 px) and
use the dark GitHub-style theme with the recorded design tokens
(`--bg #0d1117`, `--fg #e6edf3`, `--acc #2ea043`).

---

## The roles

| Role           | Key?                     | What it may contribute                              | What it may see                                            |
| -------------- | ------------------------ | --------------------------------------------------- | ---------------------------------------------------------- |
| **user**       | no key — open on purpose | mints captchas; may offer its IP as an egress point | its own counters only                                      |
| **partner**    | needs its key            | everything above, plus the token/session form       | `/status/self` (its own role, the pool shape)              |
| **admin**      | needs its key            | everything above                                    | `/status` — every partner, egress IP, pool count, features |
| **superadmin** | its own seeded key       | everything admin does                               | everything admin does, plus the people directory           |

`user` being keyless is deliberate: lending your own IP grants no access to
anyone else's browser or pool, so there is nothing to protect with a key.

`superadmin` is one account seeded at startup, above admin, and it is the only
role meant to manage the directory. Pin it with
`GLM_SUPERADMIN=<key>` (and optionally `GLM_SUPERADMIN_NAME=<name>`, default
`root`); with nothing set the hub generates a key and prints it once, so the
default is unguessable rather than a blank account anyone can claim. The account
itself is stored in `GLM_STATE_FILE` — as a salt and a hash, like everyone
else's — so a restart keeps the same key instead of printing a new one. Without
a state file only `GLM_SUPERADMIN` survives a restart.

Keys are never stored: the hub keeps a `scrypt` hash with a per-person salt, so
a copy of the state file is a list of names and a place to guess at hashes, not
a set of working credentials. Rotation replaces the hash and the response is the
only time the new key exists in plaintext. That protects the store, not the
wire — a key still crosses the network in the `/session` request body, so serve
this over TLS (a proxy in front, or `GLM_PUBLIC_URL` pointing at one) before
anyone signs in from another machine.

A session is an HMAC-signed cookie (`glm_sid`), `HttpOnly` so scripts cannot
read it, `SameSite=Lax`, one day. It is only granted after a constant-time key
check, and a forged or edited cookie is rejected.

**Every page needs a session, and `/` is the sign-in page.** Opening `admin.html`
(or any page) while signed out redirects to `login.html?next=…`, and the login
page sends you on to where you were headed — or to the page your role owns, if
you came in through the front door. So the first thing a visitor sees is the
sign-in page, never a page whose job is unclear. `/index.html` (the captured
minter) is still there for anyone who signs in; only the front door moved.
Only the login page, and the CSS, scripts and icons a page needs to render,
stay public — a purely static deploy with no hub has nothing to gate with, and
the pages say so.

**Roles do not share pages.** The hub writes a navigation bar into each page
(`<!--nav-->` in the HTML is the slot) listing only that role's links: a
partner gets their page, IP lending and the minter; an admin gets the panel, the
minter and the reference page — never each other's. The bar is written
server-side, so the right links are in the first paint and no script can show
the wrong menu. It is a map, not a lock: every route still enforces its own
role, and a signed-in visitor opening another role's page is redirected to their
own with `?wrongrole=` so the page can say why.

Keys are still **per-role, not per-person** for partner and admin: two people
holding the partner key are indistinguishable. `GLM_PEOPLE=name=role:key` adds
named people whose sessions, mint sockets and donations carry the name.

---

## How a donation flows (the mint protocol)

This is the contract the original page spoke, and the hub implements it exactly:

```
browser                              hub
   │ ── GET /minter/ws (upgrade) ─────▶│  no session cookie? → 401, socket closed
   │ ◀────────────── upgrade ──────────│  with a session: accepted
   │ ── {type:"hello", ip:"…", proto:2}▶│  ip from api.ipify.org; hub records
   │                                    │  partner {id, ip, role, mints, state}
   │ ◀── {type:"job", id:"…", payload:{mint:true}}
   │                                    │  sent to the least-recently-asked
   │                                    │  partner; only while
   │                                    │  pool + in-flight < target
   │   (page calls GLM.mintCaptchaSerialized())
   │ ── {type:"captcha", id:"…", param:"…"}▶│  recorded; pool.served++
   │      or {type:"error", …}          │  pool.failed++
   │ ◀── {type:"ping"} / ── {type:"pong"}│  every 25 s, from both sides
   │ ◀── {type:"bye"}                    │  on POST /admin/session/clear
```

While the tab is in the background the page arms a **silent audio oscillator**
(30 Hz, gain 0.01) on the first tap/keypress, which keeps the browser from
throttling it; until then a red banner asks for a tap. That technique is
reproduced from the original's code — that it keeps a tab alive for hours is
_not_ verified.

If the socket is refused, the page probes `/status/self`: a JSON answer means
“a hub is here and refused you — sign in”; anything else means “no hub on this
origin” and the page falls back to a **local demo pool** so a static host still
shows a working page. Demo mints never leave the browser and the page says so.

---

## The hub (`server/`)

One Node process, **zero dependencies**. `server/hub.mjs` is the HTTP + WebSocket
server; `server/ws.mjs` is a hand-written RFC 6455 WebSocket implementation
(handshake, text frames, fragmentation, ping/pong, close) so no package is
needed. It serves the built site from `public/` on the same origin as the
socket, which is why the pages need no configuration.

### Routes

| Route                       | Auth                             | What it is                                                                                                                                                                                                                         |
| --------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WS /minter/ws`             | session required                 | the mint socket (protocol above)                                                                                                                                                                                                   |
| `POST /session`             | key for partner/admin/superadmin | issue the signed session cookie                                                                                                                                                                                                    |
| `GET /session`              | session                          | say which role the caller is                                                                                                                                                                                                       |
| `GET /config`               | **open**                         | the deployment values the browser needs (captcha scene/prefix/appkey/region/lang/sdkUrl, FE version, upstream origins, model bases) — env-driven, with the captured originals as defaults                                          |
| `POST /tokens`              | partner or admin session         | accept a token/session donation, then verify it on arrival; keeps a fingerprint, a person and a status, never the value                                                                                                            |
| `GET /tokens`               | partner or admin session         | donation counts by status; `?mine=1` yours, `?all=1` the admin's full list                                                                                                                                                         |
| `POST /captcha/verify`      | admin session                    | re-run the Aliyun exchange on a donated value by hand                                                                                                                                                                              |
| `GET /people`               | admin session                    | the per-person registry (names, roles, usage, pinned flag), never the keys; also says whether the directory is file-backed                                                                                                         |
| `POST /people`              | **superadmin** session           | create a person: `{name, role, key?}` → 201 with the key **once**                                                                                                                                                                  |
| `POST /people/revoke`       | admin session                    | `{name}` → drop the person, their key, live sessions and open sockets, now                                                                                                                                                         |
| `POST /people/rotate`       | admin session                    | `{name}` → new key returned once, old key and sessions dead immediately                                                                                                                                                            |
| `GET /status`               | **admin** session                | the full JSON `admin.js` polls                                                                                                                                                                                                     |
| `GET /status/self`          | any signed-in role               | the public half: role, port, socket path, pool target                                                                                                                                                                              |
| `POST /features`            | admin session                    | default feature flags applied to **every** chat request; a model suffix turns one on for a single call. `persist_history` is deliberately absent - the hub keeps no conversation store, so a switch for it could never do anything |
| `POST /admin/session/clear` | admin session                    | close every connected partner socket (this is a disconnect, not a logout)                                                                                                                                                          |
| `GET /v1/models`            | open                             | the model list                                                                                                                                                                                                                     |
| `POST /v1/chat/completions` | open                             | forwards when `GLM_UPSTREAM` is set, otherwise **501** with the reason                                                                                                                                                             |
| `GET /…`                    | **session** for `.html`          | serves `public/`; signed out, pages redirect to `login.html?next=…`, while CSS/JS/icons stay public. Path traversal is refused with 403                                                                                            |

### Environment variables

Every value below that the browser needs is also published by `GET /config`,
so the page and the client library take their settings from the hub rather than
carrying a copy. **With nothing set, the hub answers with the values the
original capture used**, so a plain checkout behaves as recorded.

| Variable                          | Default                                           | Meaning                                                                                                                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                            | `5082`                                            | listen port (`127.0.0.1`)                                                                                                                                                                                                                                      |
| `GLM_KEYS`                        | — (keys generated)                                | `partner:secret,admin:secret,superadmin:secret`; other role names are ignored                                                                                                                                                                                  |
| `GLM_SUPERADMIN`                  | - (key generated, printed once)                   | the seeded superadmin's key; pinning it is one way to survive a restart - the state file is the other                                                                                                                                                           |
| `GLM_SUPERADMIN_NAME`             | `root`                                            | the seeded superadmin's name, which rides on its sessions and donations                                                                                                                                                                                        |
| `GLM_PEOPLE`                      | — (no people)                                     | per-person keys as `name=role:key` triples, e.g. `alice=partner:s3cret,bob=admin:s3cret2`; a person's name then rides on their sessions, mint sockets and donations. Always wins over `GLM_STATE_FILE`, so an env-pinned person cannot be revoked from the API |
| `GLM_STATE_FILE`                  | - (memory only)                                   | a JSON file the people directory and the seeded superadmin are written to on every change and read on start. A revoked person stays revoked across a restart. It holds names, salts and scrypt hashes - never a key - and is still written `0600`                |
| `GLM_CAPTCHA_SCENE`               | `no8xfe`                                          | the Aliyun scene id the widget is built with                                                                                                                                                                                                                   |
| `GLM_CAPTCHA_PREFIX`              | `didk33e0`                                        | the widget's element-id prefix                                                                                                                                                                                                                                 |
| `GLM_CAPTCHA_APPKEY`              | `FFFF0N00000000007EC0`                            | the public Aliyun appkey (public by design — the widget ships it to every browser)                                                                                                                                                                             |
| `GLM_CAPTCHA_REGION`              | `sgp`                                             | widget region                                                                                                                                                                                                                                                  |
| `GLM_CAPTCHA_LANG`                | `en`                                              | widget language                                                                                                                                                                                                                                                |
| `GLM_CAPTCHA_SDK_URL`             | the documented alicdn URL                         | where the browser loads `AliyunCaptcha.js` from (override for an air-gapped deploy)                                                                                                                                                                            |
| `GLM_CAPTCHA_VERIFY_URL`          | `https://captcha.aliyun.com/captcha/v3/verify`    | the server-side verify endpoint                                                                                                                                                                                                                                |
| `FE_VERSION`                      | `prod-fe-1.1.79`                                  | the `X-FE-Version` header sent upstream, and what `/status` reports                                                                                                                                                                                            |
| `GLM_REGION`                      | `overseas`                                        | the `X-Region` header sent upstream                                                                                                                                                                                                                            |
| `GLM_ZAI_ORIGIN` / `GLM_ZAI_PATH` | `https://chat.z.ai` / `/api/v2/chat/completions`  | where `z.ai/…` ids go                                                                                                                                                                                                                                          |
| `GLM_CN_ORIGIN` / `GLM_CN_PATH`   | `https://chatglm.cn` / `/api/v1/chat/completions` | where `cn/…` ids go                                                                                                                                                                                                                                            |
| `GLM_MODEL_EXTRA`                 | — (the four captured bases)                       | extra model bases, comma-separated; they are appended after the captured four and expand into the catalog                                                                                                                                                      |
| `GLM_UPSTREAM`                    | — (chat 501s)                                     | where `/v1/chat/completions` forwards; the source in the model id still picks the path, so `cn/…` keeps `/api/v1` whatever the origin                                                                                                                          |
| `GLM_UPSTREAM_KEY`                | — (no header)                                     | optional bearer credential for the upstream                                                                                                                                                                                                                    |
| `GLM_UPSTREAM_TIMEOUT`            | `30000`                                           | upstream call deadline in ms                                                                                                                                                                                                                                   |
| `GLM_SIGN_SALT`                   | the reference projects' salt                      | the HMAC salt for the upstream `x-signature`; override it only for a different origin                                                                                                                                                                          |
| `SESSION_SECRET`                  | ephemeral                                         | HMAC key for session cookies; unset = new every restart, so all sessions die                                                                                                                                                                                   |
| `TOKEN_TARGET`                    | `750`                                             | pool stops asking for mints at this count (in-flight jobs count against it)                                                                                                                                                                                    |
| `TOKEN_LOWWATER`                  | `50`                                              | below this the hub asks connected partners for more                                                                                                                                                                                                            |
| `GLM_TOKEN_TTL_MS`                | `1800000` (30 min)                                | how long a pool entry stays usable; after that the sweep moves it to `expired`                                                                                                                                                                                 |
| `GLM_SWEEP_MS`                    | `15000`                                           | how often the pool is swept for expiry and topped up, and stale sessions are cleared                                                                                                                                                                           |
| `GLM_WS_AUTH`                     | `required`                                        | set `open` to allow anonymous mint sockets — the hub logs a loud warning when you do                                                                                                                                                                           |
| `GLM_SESSION_TTL_MS`              | `86400000` (24 h)                                 | how long a sign-in lasts. Enforced **server-side** on the session's age — the cookie's `Max-Age` is only a hint, so replaying a raw cookie header past the TTL is refused. Expired sessions are swept and counted in `expiredSessions`                         |
| `GLM_PUBLIC_URL`                  | — (derived from the request)                      | the address this hub is reached at, e.g. `https://glm.example.com`; set it when a reverse proxy or tunnel hides the real name, and every page, snippet and `/config` answer uses it                                                                            |
| `GLM_TRUST_PROXY`                 | `0`                                               | set `1` behind a reverse proxy so `X-Forwarded-Host`/`-Proto` are believed; leave it off when exposed directly, or a visitor can make the panel print an address of their choosing                                                                             |
| `GLM_IP_LOOKUP_URL`               | `https://api.ipify.org?format=json`               | where the pages look up a visitor's public IP; point it at your own service when that third party is unreachable, or set it empty to stop looking up at all                                                                                                    |

### Model ids

Every model id is `<source>/<base>[-suffix]`:

- **Source** — `z.ai/` routes to chat.z.ai (overseas, `/api/v2/chat/completions`);
  `cn/` routes to chatglm.cn (`/api/v1/chat/completions`).
- **Base** — `glm-5.3`, `glm-4.7`, `glm-4.6`, `glm-5v-turbo`.
- **Suffix** — `-think` (thinking), `-search` (web search), `-deepresearch`
  (deep research); at most one of each, order as written.

So `z.ai/glm-5.3-think` and `cn/glm-5.3-search` are both valid, and bare names
like `glm-4.7` keep working as aliases for their z.ai id. `GET /v1/models`
lists all 32 catalog ids with each one's declared features — declared, not
exercised: what a suffix actually does on the wire depends on the upstream.
The hub rewrites the model id to the source's plain base name, sets the
declared feature flags in the body, and forwards with the pool's FE version
and region headers.

### What it deliberately does not do

- **It does not validate a minted captcha before spending it.** A param is
  recorded and then spent as-is on the next chat call; `/status` says so in
  `pool.note` instead of implying the params are good. Only donations and an
  explicit `POST /captcha/verify` are exchanged with Aliyun.
- **It does not forward chat without a destination.** With `GLM_UPSTREAM` set it
  forwards, signs, and spends a pool entry; with nothing set the endpoint answers
  501 honestly rather than faking 200s. No credential ships, so a plain checkout
  refuses.
- **It does not persist the pool.** People survive a restart when
  `GLM_STATE_FILE` is set, but pool entries are captcha params that expire in
  half an hour — writing them to disk would be a liability, not a feature. A
  restart still empties the pool and invalidates sessions.
- **It does not have accounts.** Keys are per-person (`GLM_PEOPLE`, or people
  created through `POST /people`), with runtime revocation and rotation, but
  there is no sign-up, no password store and no password reset — the key _is_
  the account.

---

## Checks

```bash
npm run check        # the chain: html, links, then the five hub suites, then docs (not the last two below)
node check-html.mjs          # every built page's tags balanced and properly nested
node check-links.mjs         # every local href/src resolves inside dist/
node check-hub.mjs           # 60 expectations: auth gates, session, socket, /status, models, upstream, donations
node check-hub-multi.mjs     # 9 expectations: 3 partners, even spread, pool stops at target
node check-config.mjs        # 97 expectations: dynamic config, the page gate, per-role pages, the pool life cycle, session expiry
node check-chat.mjs          # 27 expectations: forwarding, request signing, pool spend and refund, feature defaults
node check-people.mjs        # 56 expectations: create, revoke, rotate, the state file, hashing at rest, the seeded superadmin across a restart
node check-docs.mjs          # the hand-off note still matches the code: every setting and path it names exists
node check-serve.mjs <url>   # every page and asset is actually served
node check-html-selftest.mjs # proves the nesting check catches an orphaned block
```

`check-hub.mjs` spawns the real hub on a spare port with pinned keys
(`GLM_KEYS=partner:test-partner-key,admin:test-admin-key`) and exercises the
contract like a client would: refused without a session, refused with a wrong
key, partner socket accepted with its cookie, one real mint round trip, admin
reading `/status`, and the honest 501. `check-hub-multi.mjs` connects three
fake partners with different egress IPs and asserts the spread: 10/10/10 of 30,
no job id sent twice, nothing failed, everyone idle at rest.

`check-config.mjs` is what proves the deployment values are **dynamic, not baked
in**. It starts the hub twice. First with nothing configured, and asserts every
captcha value, the FE version, both upstream origins and the four model bases
come back exactly as the original capture had them — that is the faithful
default. Then with every knob overridden, and asserts each override wins, the
extra model bases appear in `/v1/models`, and the catalog grew by 8 ids per new
base. It also proves the page gate (a stranger is redirected to
`login.html?next=…`, the login page and its assets stay public, a signed-in
session gets the page), that path traversal is refused with 403 rather than
redirected, that the seeded superadmin is above admin and its key is never
echoed, and that `/status` publishes the pool's ttl / expired / consumed /
low-water figures.

---

## Project layout

```
app/
├── public/            the site (this is what build copies)
│   ├── index.html     minter page
│   ├── minter.js/.css minter behaviour + theme
│   ├── glm-client.js  captcha client (GLM.mintCaptchaSerialized)
│   ├── login.html     roles + key sign-in
│   ├── user.html      the "lend an IP" page
│   ├── partner.html   the "lend accounts" page
│   ├── admin.html/.js the operator panel
│   ├── repos.html     reference-project dissection
│   ├── roles.js       shared role logic (sign-in, switches, logs)
│   └── role.css
├── server/
│   ├── hub.mjs        the backend (one file, no dependencies)
│   └── ws.mjs         hand-written RFC 6455 WebSocket server
├── dist/              build output (static files only — server code never reaches it)
├── .repos/            downloaded reference archives (research material, not published)
├── build.mjs          copies public/ → dist/, fails if server code would leak into dist/
├── check-*.mjs        the check suites
└── README.md          this file
```

---

## How the behaviour maps to the original

Everything below was observed in the recorded capture of the original page
(`capture/how-it-works.md`, `capture/page.html`):

1. **Background mode** — a silent oscillator (30 Hz, gain 0.01) starts on the
   first tap/keypress so the tab isn't throttled; a red warning shows until
   then, a green confirmation after.
2. **Hub connection** — WebSocket to `/minter/ws`; on open sends
   `{"type":"hello","ip":"…","proto":2}` (IP from `api.ipify.org`), pings every
   25 s, reconnects with 800 ms × 1.7 backoff capped at 15 s.
3. **Mint jobs** — on `{"type":"job","id":…,"payload":{"mint":true}}` the page
   mints a captcha param and replies `{"type":"captcha",…}` or
   `{"type":"error",…}`. Non-mint payloads are refused client-side.
4. **UI** — three stat tiles (status / mints / in flight), an activity log
   capped at 40 entries (newest first), the visitor's egress IP.

## What is not done yet — and what would finish each one

Honest list, also shown on the admin page. Each item has a step-by-step runbook
in [`HANDOFF.md`](HANDOFF.md#what-is-not-done-yet) — the commands to run, what a
pass looks like, and where to record the result.

- **Donations are verified on arrival, but nothing consumes them.** The hub
  exchanges a donated captcha param with Aliyun as soon as it arrives and
  records valid / invalid / unverified; a device token that is not a captcha
  param settles as `unverified` rather than being claimed good. What is still
  missing: turning a verified donation into a spendable pool entry.
- **The pool has a life cycle and a consumer.** Entries carry an expiry, the
  sweep moves them to `expired`, the hub refills towards `TOKEN_LOWWATER` /
  `TOKEN_TARGET`, and the chat path now takes the oldest entry, attaches it to
  the upstream call as `captcha_verify_param`, and returns it unspent on a
  401/403/429. What remains unproven is the call to the live service.
- **Egress offer is a toggle only.** No traffic is routed through a volunteer's
  IP, and there is no Tor client.
- **Captcha minting is browser-side.** The hub can check a minted param against
  Aliyun, but the hub itself does not mint — that stays the partner browser's
  job, and no automated proof-of-mint has run against the real widget yet.
  Configured via `GET /config`, the client now loads the real SDK whenever the
  hub is present; where no hub answers it still runs the labelled demo.
- **Suffix features are declared, not exercised.** `-think`, `-search`,
  `-deepresearch` rewrite the model id and set feature flags, but no live
  upstream call has proven what they do on the wire (needs a credential).
- **Identity is per-person, revocable, and rotatable.** `GLM_PEOPLE` gives each
  person their own key; a superadmin creates more through `POST /people` and gets
  the key back once. `POST /people/revoke` drops the key, the live sessions and
  the open mint sockets on the next request with no restart, and
  `POST /people/rotate` issues a new key while killing the old one. With
  `GLM_STATE_FILE` set the directory — including revocations and the seeded
  superadmin — survives a restart. A key pinned in the environment cannot be
  revoked from the API, on purpose: the environment wins, or a stale file could
  resurrect it. Keys are stored as `scrypt` hashes with a per-person salt, so the
  file is not a credential dump; a `version: 1` file that still holds plaintext
  keys is hashed and rewritten on load. What is left open: the session cookie
  carries a random id (`glm_sid`), not a key, and there is no TLS here, so a key
  in transit is only as private as the connection you serve it on.
- **Roles keep to their own pages, but a key is still the only identity.** The
  hub writes a navigation bar into each page listing only that role's links, and
  redirects a signed-in visitor away from another role's page (`?wrongrole=`)
  instead of showing a panel that would only refuse its data. That is a map,
  not a lock: it stops a wrong click, not a determined reader, and every JSON
  route still checks its own role. There are no accounts beyond the key — no
  sign-up, no password store.
- **Upstream forwarding is opt-in, and proven only against a stub.** With
  `GLM_UPSTREAM` set, chat forwards there — signing each request, spending a pool
  entry on it, keeping `cn/` and `z.ai/` on their own paths — and without it,
  `/v1/chat/…` answers 501 rather than faking success. `check-chat.mjs` proves the
  whole call against a local stub; no call to the live service has succeeded,
  because no credential was ever supplied.
- **Only the directory is persisted.** The pool, sessions and donations live in
  memory, so a restart empties the pool and invalidates every session. That is
  deliberate: pool entries are captcha params that expire in half an hour.
  Persisting them would be the same `savePeople()` pattern applied to short-lived
  credentials — a liability rather than a feature.
- **Only one token source is exercised.** `chat.z.ai` and `chatglm.cn` both have
  origins and model ids, but the collector work and all three reference projects
  centre on z.ai. Whether chatglm.cn issues usable tokens the same way is
  untested.
- **Unverified:** long-run background-tab survival (the oscillator technique is
  reproduced, its effect unobserved), and page likeness at 390 px width
  (98–100% layout match at 1440/768 px in the recorded comparison rounds).

## The reference projects

`repos.html` dissects the three projects this rebuild was informed by, read
from their source (downloaded by `fetch-repos.mjs` into `app/.repos/`, excluded
from the published site):

- **pingmike2/zai2api** — Go single-binary port; SQLite token store consumed
  FIFO; in-process Aliyun captcha; one static proxy for the WAF.
- **D3-vin/GLM-ZAI-2API** — the most complete: three API protocols, vision,
  tool-calling adapter, browser TLS fingerprint, account pool, rotating WAF
  proxies, in-process captcha with a ported DeviceData generator.
- **chaoticmindv/zai2api** — Node.js rewrite for easy Windows use; Playwright
  stealth collector harvests device tokens from chat.z.ai into SQLite.

What none of them has — and what this project adds — is the **partner surface**:
a page a third person can open, a hub that spreads the work across everyone
connected, and a consent-honest explanation of what runs in their browser.
