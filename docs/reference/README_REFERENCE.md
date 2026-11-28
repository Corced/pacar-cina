# glm2api · captcha minter — clean-room rebuild

A rebuild of the `/minter` page from `babsbsb-glm-worker.hf.space` — the page
partners keep open so their browsers mint Aliyun captcha solutions for a shared
pool — plus the backend it implied: a hub that spreads the mint work across
every connected browser, knows who is contributing, and refuses strangers.

Everything here was written from recordings of the original page and from
reading the source of three reference projects. Nothing was copied: no original
code, no logos, no long passages.

Written and maintained by **Corced**.

**Taking over the project?** [`START-HERE.md`](../start/START-HERE.md) is the shortest
orientation: the shape of the system, the four ideas that explain the code, what
is proven, and a separate table of the gaps that need a person (a credential, a
real browser, half an hour) rather than a commit. Then
[`HANDOFF.md`](../archive/HANDOFF.md) — it states what is proven and what is not, and lists
the traps that have already caught someone. This file is the reference: every
route, every setting, the protocol in full. If you only want to start it and poke
at it, [`INSTRUCTION.md`](../guides/INSTRUCTION.md) is the one-page operator guide.

---

## Is the "session donation" finished?

**Yes for the part the whole project exists for — with honest edges.**
"Session donation" here means three different things, and they are in
different states:

| What is donated                                                                                            | State                                                                                                                                                                                                                                                                           | Proven by                                                                |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **A browser's mint work** - a partner keeps a tab open; the hub sends it captcha jobs; the browser answers | **Finished and proven.** Key-gated socket, real job round trip, even spread across partners, pool stops exactly at its target, entries expire and the pool refills itself; a graceful close takes the partner offline and frees a job it was holding instead of leaving it busy | `check-hub.mjs` (73 assertions) + `check-hub-multi.mjs` (9), all green |
| **Tokens / sessions pasted into `partner.html`**                                                           | **Accepted and verified on arrival.** The form POSTs to `POST /tokens`; the hub keeps only a SHA-256 fingerprint, checks the value with Aliyun straight away, and records valid / invalid / unverified — never the value                                                        | `check-hub.mjs` (donation expectations)                                  |
| **An IP as an egress point** (`user.html`)                                                                 | **Reported, not routed.** The page shows what the hub can prove about this address (is a minter socket from it open, how many captchas that address returned) and nothing it cannot; no traffic is routed through it                                                                 | `check-hub.mjs` (`/status/self` expectations)                            |

So: open the hub, sign in as a partner, open the minter tab — that flow works
end to end today, and the values it runs on (captcha scene, appkey, FE version,
upstream origins, model list) come from the environment rather than the source.
Routing traffic through volunteer IPs is documented on its page as not-yet-real
rather than faked.

---

## Quick start

```bash
npm run build        # optional: copies public/ into dist/ for a static copy
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
| Chat    | `chat.html` + `chat.js`    | The one page every signed-in role gets. Model picker from `GET /v1/models`, a transcript, one turn at a time; it keeps the `x-glm-chat` id and hands it back, so a follow-up continues the topic. Text lives in the tab only — a reload starts a clean transcript while the hub keeps the conversation. Every refusal (400/404/409/429/501/502) is quoted, not smoothed over. |
| Sign in | `login.html`               | **The front door.** `/` redirects here (or to your own page if you are already signed in). One field: a key. The page names no roles and shows no capability table - the key itself says which role it is (the hub resolves it against the people registry, then the role keys), and a key that matches nothing is refused rather than quietly made a `user`. A visitor with no key continues as **user**, the open role that grants only lending an address. |
| User    | `user.html` + `user.js`    | A report, not a control: polls `GET /status/self` every 5 s and shows this address as the hub saw it (is a minter socket from it connected, how many captchas it returned) plus live pool numbers. Solving happens on the minter page; this page says so and links there. |
| Partner | `partner.html`             | “Lend accounts”. The token/session paste form (currently local-only), contribution counters, same minting ability as everyone.                                                                                                                                  |
| Admin   | `admin.html`               | The operator panel: status, partner pool (id, IP, role, mints, state), token pool, shared upstream tokens (contribute, health, revoke), feature defaults, a read-only egress panel (mode, routes, dead, last error), endpoints, activity log, a key box on 401/403. |
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
| `POST /tokens`              | partner or admin session         | accept a token/session donation, then verify it on arrival; keeps a fingerprint, a person and a status, never the value; **429** + `retry-after` past `GLM_DONATE_CONCURRENCY` for one caller                                |
| `GET /tokens`               | partner or admin session         | donation counts by status; `?mine=1` yours, `?all=1` the admin's full list                                                                                                                                                         |
| `POST /captcha/verify`      | admin session                    | re-run the Aliyun exchange on a donated value by hand                                                                                                                                                                              |
| `GET /people`               | admin session                    | the per-person registry (names, roles, usage, pinned flag), never the keys; also says whether the directory is file-backed                                                                                                         |
| `POST /people`              | **superadmin** session           | create a person: `{name, role, key?}` → 201 with the key **once**                                                                                                                                                                  |
| `POST /people/revoke`       | admin session                    | `{name}` → drop the person, their key, live sessions and open sockets, now                                                                                                                                                         |
| `POST /people/rotate`       | admin session                    | `{name}` → new key returned once, old key and sessions dead immediately                                                                                                                                                            |
| `POST /upstream/keys`       | any signed-in role               | contribute a bearer token for `z.ai` or `cn`: shape, then JWT claims offline, then one 5 s probe that signs its own prompt. Kept **in memory only**; **409** for a token already held; **400** with the reason for expired, malformed or refused ones; the token is never echoed, logged or written down |
| `GET /upstream/keys`        | any signed-in role               | metadata rows only — 8-char id, source, contributor, uses, last use, health. Your own rows, or every row as admin. A token never appears here or anywhere else |
| `POST /upstream/keys/revoke`| the contributor or an admin      | `{id}` → drop that token now; **404** unknown id, **403** somebody else's |
| `GET /status`               | **admin** session                | the full JSON `admin.js` polls                                                                                                                                                                                                     |
| `GET /status/self`          | any signed-in role               | the public half: role, port, socket path, pool target, plus `you` (this caller's address, whether a minter socket from it is connected, and how many captchas it returned) and `poolNow` (live tokens/in-flight/online/minted) — what `user.html` polls every 5 s |
| `POST /features`            | admin session                    | default feature flags applied to **every** chat request; a model suffix turns one on for a single call. `persist_history` is deliberately absent - the hub keeps no conversation store, so a switch for it could never do anything |
| `POST /admin/session/clear` | admin session                    | close every connected partner socket (this is a disconnect, not a logout)                                                                                                                                                          |
| `GET /v1/models`            | open                             | the model list                                                                                                                                                                                                                     |
| `POST /v1/chat/completions` | open                             | forwards when `GLM_UPSTREAM` is set, otherwise **501** with the reason; **429** + `retry-after` past `GLM_CHAT_CONCURRENCY` for one address or identity; **404** for a `chat_id` that is not this caller's; **409** while that conversation already has a turn in flight; replies carry `x-glm-chat` / `x-glm-caller`      |
| `GET /…`                    | **session** for `.html`          | serves `public/`; signed out, pages redirect to `login.html?next=…`, while CSS/JS/icons stay public. Path traversal is refused with 403                                                                                            |

### Environment variables

Every value below that the browser needs is also published by `GET /config`,
so the page and the client library take their settings from the hub rather than
carrying a copy. **With nothing set, the hub answers with the values the
original capture used**, so a plain checkout behaves as recorded.

Copy `.env.example` to `.env` and run `npm run hub:env` — Node loads the file
with `--env-file`, and `npm run hub` never reads it, so a shell-only setup is
unchanged. `.env` is git-ignored, which is where real keys belong; the people
state file belongs outside the repo for the same reason.

| Variable                          | Default                                           | Meaning                                                                                                                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                            | `5082`                                            | listen port                                                                                                                                                                                                                                                    |
| `HOST`                            | `127.0.0.1` (`0.0.0.0` when `NODE_ENV=production`) | listen interface. Loopback by default so a laptop exposes nothing; a container needs `0.0.0.0`, or the platform's router and health check reach nothing while the process looks healthy                                                                         |
| `NODE_ENV`                        | —                                                 | `production` binds `0.0.0.0` unless `HOST` says otherwise; it changes nothing else                                                                                                                                                                             |
| `GLM_KEYS`                        | — (keys generated)                                | `partner:secret,admin:secret,superadmin:secret`; other role names are ignored                                                                                                                                                                                  |
| `GLM_SUPERADMIN`                  | - (key generated, printed once)                   | the seeded superadmin's key; pinning it is one way to survive a restart - the state file is the other                                                                                                                                                           |
| `GLM_SUPERADMIN_NAME`             | `root`                                            | the seeded superadmin's name, which rides on its sessions and donations                                                                                                                                                                                        |
| `GLM_PEOPLE`                      | — (no people)                                     | per-person keys as `name=role:key` triples, e.g. `alice=partner:s3cret,bob=admin:s3cret2`; a person's name then rides on their sessions, mint sockets and donations. Always wins over `GLM_STATE_FILE`, so an env-pinned person cannot be revoked from the API |
| `GLM_STATE_FILE`                  | - (memory only)                                   | a JSON file the people directory, the seeded superadmin and the minted-token pool are written to on every change and read on start. A revoked person stays revoked and unexpired pool entries come back across a restart. It holds names, salts and scrypt hashes - never a person's key - plus single-use captcha params while they live, and is written `0600`                |
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
| `GLM_UPSTREAM_KEY`                | — (no header)                                     | optional bearer credential for the upstream; a verified token in the shared pool wins over it for its own source, and `x-glm-key` says which one answered                                                                                                                                                                       |
| `GLM_UPSTREAM_TIMEOUT`            | `30000`                                           | upstream call deadline in ms                                                                                                                                                                                                                                   |
| `GLM_EGRESS_ROUTES`               | — (direct)                                        | comma-separated `host:port` SOCKS5 endpoints (no auth) for the chat forward and the upstream-key probe; empty means every call goes direct. Captcha verification and donations always stay direct                                                                 |
| `GLM_EGRESS_MODE`                 | `proxy` when routes exist, else `direct`          | `direct` forces routing off even with routes configured; `tor` uses the same client and only changes the label and the address                                                                                                                                  |
| `GLM_EGRESS_DEAD_MS`              | `60000`                                           | how long a route that failed its handshake is skipped before it is tried again                                                                                                                                                                                 |
| `GLM_CHAT_CONCURRENCY`            | `4`                                               | how many `/v1/chat/completions` one address may hold at once, and one identity on top of that; the next one gets **429**                                                                                                                                                                         |
| `GLM_CHAT_COOLDOWN_MS`            | `5000`                                            | how long a caller waits after being refused, in ms; `0` turns the wait off and leaves only the concurrency cap                                                                                                                                                 |
| `GLM_CHAT_KEEP_CHARS`             | `6000`                                            | characters of one conversation the hub replays when a caller continues it with only a new message; the oldest turns fall off first                                                                                                                             |
| `GLM_DONATE_CONCURRENCY`          | `4`                                               | how many captcha-shaped donations one caller may have verifying against Aliyun at once; the next gets **429**                                                                                                                                                  |
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

### Deploying it

**Hosting the hub and browser pages?** See [`DEPLOYMENT.md`](../guides/DEPLOYMENT.md) for an end-to-end guide: one process, Docker or systemd, TLS, persistent state, host checks and free-tier hosting limits. **Getting free-tier credentials?** See [`DEPLOYMENT_QUICKSTART.md`](../guides/DEPLOYMENT_QUICKSTART.md) for step-by-step runbooks, with current source facts in [`FREE_TIER_RESEARCH.md`](../research/FREE_TIER_RESEARCH.md).

**One always-on process, one replica, one volume.** The partner sockets, sessions,
minted pool, chat ledger and contributed upstream tokens all live in that
process's memory, so a second replica behind a load balancer would split them
between two hubs — sticky sessions do not help, because `/minter/ws` is a
long-lived upgrade. That rules out serverless (no long-lived listener, no
WebSocket upgrades, no `setInterval` sweeps) and rolling deploys that overlap.

A `Dockerfile` is in the repo: `docker build -t glm2api . && docker run -p 5082:5082 -v glmdata:/data -e GLM_STATE_FILE=/data/state.json -e GLM_KEYS=admin:<key> glm2api`.
`npm start` runs the same command the image does. `npm run build` is **not**
part of deploying — it only makes a static copy of `public/` in `dist/`; the hub
serves `public/` directly.

Behind the platform's TLS and router, set `GLM_TRUST_PROXY=1` (so
`X-Forwarded-*` are believed and per-caller limits key on the real address rather
than the proxy's) and `GLM_PUBLIC_URL=https://…` (so `/config`, snippets and
`/status` name the outside address). The session cookie gains `Secure` by itself
whenever the request arrives as https. Expect every restart to sign everyone
out: the session rows are in memory, so `SESSION_SECRET` only keeps the
signature stable, not the sessions.

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

**The catalog is a list, not an allow-list.** The upstream keeps adding words to
its own model names, so the suffix is stripped from the **right** and whatever
remains is the base: `z.ai/glm-5.3-max-think` forwards `glm-5.3-max` with
thinking on, even though no catalog entry exists for it. Two rules keep that
from meaning "forward anything": the source must be `z.ai` or `cn`, and an
unknown base must start with `glm` (`z.ai/gpt-9` is still a 400). Any other name
is pinned exactly with `GLM_MODEL_EXTRA`, so a base that genuinely ends in
`-think` is never re-split. An id outside the catalog is served and labelled
`x-glm-model-known: false` rather than silently treated as known.

**One conversation, and it resumes.** The hub mints the `chat_id` for every
request and returns it in `x-glm-chat`. Hand that id back in the next request's
`chat_id` and the conversation continues:

```jsonc
// turn 1
{ "model": "z.ai/glm-5.3", "messages": [{ "role": "user", "content": "who wrote Dune?" }] }
// -> x-glm-chat: chat-4c5d...  body: "Frank Herbert."

// turn 2 — one new line is enough, the hub replays the turns it relayed
{ "model": "z.ai/glm-5.3", "chat_id": "chat-4c5d...",
  "messages": [{ "role": "user", "content": "and the sequel?" }] }
```

`/chat.html` does both of these for you: it keeps the id the hub returned and
hands it back with the next turn, so the topic carries over without re-pasting
anything. The transcript itself is the tab's memory, not the hub's — reload and
the text is gone while the conversation is still there.

A client that sends its whole history (what OpenAI clients do) is taken at its
word — the opening message is the test, so nothing is duplicated. **One turn at a
time:** a second request for a conversation that already has one in flight gets
`409` (`chat_busy`), because two would each be built without the other's reply
and then overwrite each other's turns — one conversation, two histories. The hub
keeps at most `GLM_CHAT_KEEP_CHARS` (6000) characters per conversation and drops
the oldest turns first, keeping a leading system message and always the last
exchange; the text stays in this process only, is never written to disk, and
`/status` reports the turn **count**, never the content. A restart loses it all,
so the next continuation answers `404` and the client starts fresh.

The honest ceiling on that memory: the budget is measured in characters, not
enforced as a byte cap — the last exchange always survives, and one request body
is capped at 64 KB (`readBody`), so 200 kept conversations can hold roughly 12 MB
of text at the very worst. Deleting a conversation is not offered; the oldest is
evicted once 200 exist, which also means a caller who starts 200 new chats
evicts everybody else's.

**Only the caller that minted an id can continue it.** The row is bound to the
8-hex HMAC tag of the caller (`person:alice`, or `role:…`, or `ip:…`), and a
request with an id that belongs to somebody else gets exactly the same `404` as
an id that never existed — so the id cannot be used to probe for other people's
conversations. Two callers therefore cannot bleed into each other's chat even
when they share the one upstream credential. Each reply carries `x-glm-chat`
(the id), `x-glm-caller` (the tag), `x-glm-caller-kind` (`person`/`role`/`ip`)
and `x-glm-chat-continued`; the tag, never the name, also rides upstream as
`x-glm-caller`, and `/status.chatLedger.recent` maps the last 20 ids back to the
identity that made them. The honest limit: the tag proves *which hub user* a
chat belongs to — it cannot make one upstream account into many, and anyone who
shares one person's key is that person.

### What it deliberately does not do

- **It does not validate a minted captcha before spending it.** A param is
  recorded and then spent as-is on the next chat call; `/status` says so in
  `pool.note` instead of implying the params are good. Only donations and an
  explicit `POST /captcha/verify` are exchanged with Aliyun.
- **It does not forward chat without a credential it can use.** With `GLM_UPSTREAM` set it
  forwards, signs, and spends a pool entry; the credential is a contributed
  upstream token (the shared pool) or `GLM_UPSTREAM_KEY`, and the reply says which
  answered (`x-glm-key: pool|pool-unverified|env|none`). With nothing set the
  endpoint answers 501 honestly rather than faking 200s. No credential ships with
  the repo, so a plain checkout refuses until one is contributed.
- **It persists the pool when you ask it to.** With `GLM_STATE_FILE` set, minted
  params survive a restart until they expire (the file is `0600`, filtered to
  entries still inside their TTL, and expired ones are dropped on load), and the
  people directory survives with them. What it deliberately does not keep: bearer
  tokens contributed to the shared upstream pool (an account credential is never
  written down — only a single-use captcha param is), sessions, jobs, the
  donation ledger or the chat ledger. A restart still signs everyone out and
  empties those.
- **It does not have accounts.** Keys are per-person (`GLM_PEOPLE`, or people
  created through `POST /people`), with runtime revocation and rotation, but
  there is no sign-up, no password store and no password reset — the key _is_
  the account.
- **It does not compile the frontend.** No TypeScript, no bundler: the six
  scripts in `public/` are the bytes the browser runs, which is why a browser
  failure can be read straight off the file. All six open with `// @ts-check`
  and carry JSDoc `@typedef`s for the wire shapes they read, so
  `check-types.mjs` checks them with `tsc --strict` whenever a `tsc` is on PATH
  (and says "skipped" when there is none — zero dependencies wins). The
  annotations are comments to the browser: the compiler is a dev tool, never a
  build step. Turning them on cleared 272 diagnostics and found one real defect
  (a duplicate `language` key in the Aliyun options); the rest were absent
  annotations and null checks, so this was a file-at-a-time job, not a switch.
  A new script opts in with the same comment line, and `check-types.mjs` picks
  it up on its own.

---

## Checks

```bash
npm run check        # the chain: html, links, types, the five hub suites, docs, then the doctor's self-test
node check-html.mjs          # every built page's tags balanced and properly nested, every id a script reads defined
node check-links.mjs         # every local href/src resolves inside dist/
node check-types.mjs         # the scripts that opt in with // @ts-check type-check clean (skips when no tsc is installed)
node check-hub.mjs           # 73 assertions: auth gates (a key names its role), session, socket, /status, /status/self, models, upstream, donations, the donation cap
node check-hub-multi.mjs     # 9 expectations: 3 partners, even spread, pool stops at target
node check-config.mjs        # 113 assertions: dynamic config, the page gate, the chat page, per-role pages, the pool life cycle, session expiry
node check-chat.mjs          # 98 assertions: forwarding, request signing, pool spend and refund, feature defaults, the per-address and per-caller 429
node check-people.mjs        # 57 expectations: create, revoke, rotate, the state file, hashing at rest, the seeded superadmin across a restart
node check-docs.mjs          # the hand-off note still matches the code: every setting and path it names exists
node doctor.mjs              # what is still open and the exact command that closes it (add --self-test to prove the report)
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
│   ├── login.html     one key field, no role list
│   ├── chat.html/.js  the chat page every signed-in role gets
│   ├── user.html/.js  what the hub can prove about your address
│   ├── partner.html   the "lend accounts" page
│   ├── admin.html/.js the operator panel
│   ├── repos.html     reference-project dissection
│   ├── roles.js       shared role logic (sign-in, storage, logs)
│   └── role.css
├── server/
│   ├── hub.mjs        the backend (one file, no dependencies)
│   ├── ws.mjs         hand-written RFC 6455 WebSocket server
│   └── socks5.mjs     hand-written SOCKS5 client for routed chat calls
├── dist/              build output (static files only — server code never reaches it)
├── .repos/            downloaded reference archives (research material, not published)
├── build.mjs          copies public/ → dist/, fails if server code would leak into dist/
├── check-*.mjs        the check suites
├── doctor.mjs         what is still open and the command that closes it (live: one real call)
├── Dockerfile         one always-on image; .dockerignore keeps .env and dist out
├── START-HERE.md      orientation: the shape, the ideas, what needs a person
├── HANDOFF.md         the evidence ledger: proven, closed, open, traps
└── README.md          this file
```

---

## How the behaviour maps to the original

Everything below was observed in the recording of the original page. The capture
files are no longer shipped in this repository.

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
in [`HANDOFF.md`](../archive/HANDOFF.md#what-is-not-done-yet) — the commands to run, what a
pass looks like, and where to record the result.

Start with `node doctor.mjs`: it reads this list from the note, prints what each
gap needs, says which of those this machine already has, and gives the exact next
command. When `GLM_UPSTREAM` and a key are set, `node doctor.mjs live` makes one
real call and tells you `PROVEN` or the exact code that refused it — no curl, no
cookie jar.

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
- **Egress is a SOCKS5 client, not a volunteer network.** Upstream chat calls and
  the upstream-key probe can be routed through a `GLM_EGRESS_ROUTES` list, and
  every reply says which way it went (`x-glm-egress`); a dead route falls back
  with a label, never silently. What it does **not** do: route a volunteer
  browser's IP (the offer is still recorded, not used), or ship a Tor client —
  point `GLM_EGRESS_ROUTES` at a local Tor SOCKS port and the circuit only
  changes the address.
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
- **One address holds at most four chat requests.** `GLM_CHAT_CONCURRENCY`
  (default 4) counts requests in flight per address, and a signed-in caller holds
  its own identity on top - a named person, else the role. The next one gets
  **429** with `retry-after` and `{type:"rate_limit_error", limit, retry_after_seconds}`.
  A refusal spends no pool entry, and the caller then waits
  `GLM_CHAT_COOLDOWN_MS` (default 5000) before trying again; a retry inside that
  wait is refused too, so a client that ignores the 429 cannot spin. Slots come
  back on success, on an upstream error and on a timeout. The address bucket is
  what stops a second account being a second budget: two tabs, two people or a
  signed-in and an anonymous caller on one machine share one ceiling, and only
  another address gets another. That is also the limit of it - a caller with a
  second address needs the proxy in front to be the limiter, and two people
  behind one NAT are held to one budget.
- **A flood of donations is capped per caller, and nothing consumes them.** Each
  captcha-shaped donation is one outbound Aliyun exchange, so a partner pasting
  a hundred values would open a hundred calls at once: `GLM_DONATE_CONCURRENCY`
  (default 4) caps them per caller, and the next one gets **429** +
  `retry-after` before it is recorded or sent. A donation that is not
  captcha-shaped never reaches the network at all, so this only bites a caller
  sending something that looks like a real param. Note what it does *not* buy:
  a donation is verified and recorded, never replayed upstream, so a thousand
  chatglm.cn or z.ai sessions add zero chat capacity - only a minted param does.
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
