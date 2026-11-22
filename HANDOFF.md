# Hand-off note

Everything you need to pick this up without reading the whole `app/` tree.
Written for someone who did not build it. Maintained by **Corced**.

**New here? Read [`START-HERE.md`](START-HERE.md) first** — the orientation pass:
the shape of the system, the four ideas that explain the code, and a separate
table of the gaps that need a person rather than a commit. This note is the
evidence behind it.

- What the project is: the next section.
- **Honest status:** [What actually works](#what-actually-works) and
  [What is not done](#what-is-not-done-yet) — read those two before trusting
  anything else, including the pages.
- **Traps:** [Before you change anything](#before-you-change-anything).
- `README.md` is the long version (routes, every setting, the protocol in full).

---

## What this is

A rebuild of one page — a captcha "minter" — plus the backend that page needs to
be useful. The original page is a browser tab a volunteer leaves open; it asks
Aliyun's captcha widget for a verification parameter and hands it to a bot farm
in exchange for free API access. That page, alone, helps exactly one person.

The rebuild keeps that page faithful (same markup, same colours, same WebSocket
contract) and adds the part the original never had: **a hub** that many people
connect to, so the work spreads across all of their browsers instead of one.
That is the whole idea. Everything else is in service of it.

Two consequences worth stating plainly, because they shape the design:

1. **It is a consent surface.** Anyone connecting is lending a browser tab and
   their network address to somebody else's automation. The pages say so, and
   nothing claims more than it does.
2. **Some of it cannot be finished from here.** Minting needs a real captcha
   widget; forwarding chat needs a real credential. Where that is true, the code
   refuses and explains rather than pretending — see
   [What is not done](#what-is-not-done-yet).

### Words used in this note

| Word         | Means                                                               |
| ------------ | ------------------------------------------------------------------- |
| **hub**      | the Node process (`server/hub.mjs`). One small web server.          |
| **minter**   | the browser page (`index.html`) that answers mint jobs.             |
| **mint**     | asking Aliyun's widget for one captcha verification parameter.      |
| **donation** | a value a partner sends the hub: a captcha param or a device token. |
| **pool**     | the hub's in-memory store of donated values.                        |
| **partner**  | a person who signs in and donates from their browser.               |
| **role**     | user / partner / admin / superadmin — what you are allowed to do.   |

---

## Running it

```bash
npm run build     # copies public/ → dist/
npm run hub       # starts the hub on 127.0.0.1:5082
npm run hub:env   # the same, loading .env (copy .env.example first)
npm run check     # the whole test suite (see Verifying)
```

`.env` is only read by `npm run hub:env` — the hub itself looks for no dot env.
`dist/`, `.slim/` and `.repos/` are generated or downloaded and git-ignored;
`npm run build` and `node fetch-repos.mjs` bring them back.

Open the hub's address. You land on the sign-in page — that is deliberate, `/`
redirects there. Keys are printed to the console at startup when you have not
set any; the `user` role needs no key.

Sign in and the bar has three working things: **chat** (`/chat.html`, any
role — pick a model, talk, and the next turn continues the same conversation),
the **minter** (`/index.html`, the only page that solves captchas and feeds the
pool), and your own page (`user.html` reports what the hub can prove about your
address; `partner.html` takes donations; `admin.html` is the operator panel).

There is no `npm install`. **Zero runtime dependencies** is a constraint, not an
accident: `server/ws.mjs` is a hand-written WebSocket server so the WebSocket
library was not needed either.

---

## How the pieces fit

```
  browser (partner)                    this process                 the internet
 ┌──────────────────┐   WebSocket   ┌────────────────┐   HTTPS   ┌──────────────┐
 │ index.html       │◄─────────────►│                │──────────►│ Aliyun       │
 │  + minter.js     │  job / captcha│  server/       │  verify   │ captcha API  │
 │  + glm-client.js │               │  hub.mjs       │           └──────────────┘
 │                  │   HTTPh       │  ws.mjs        │──────────►┌──────────────┐
 │ admin.html       │◄─────────────►│                │  forward  │ chat.z.ai /  │
 │ partner.html     │   /status     │  (no deps)     │           │ chatglm.cn   │
 │ user.html        │   /config     └────────────────┘           └──────────────┘
 └──────────────────┘                        │
       ▲                                     │ in-memory only
       │ static files from public/           ▼
   login.html  ── the front door ──   pool: donated values + sessions
```

Two facts fall out of that picture and matter later:

- **All state is in memory.** Restart the hub and the pool empties, sessions die,
  and any auto-generated key changes. [See traps.](#before-you-change-anything)
- **The captcha widget only runs in a browser.** The hub can _check_ a minted
  parameter against Aliyun, but it cannot mint one. That is why the minter page
  exists at all, and why the hub alone is not a token source.

### A donation, start to finish

```
partner.ts                         hub                            aliyun
   │                                │                                │
   │── WS hello {ip, v:2} ─────────►│  registers as an egress point  │
   │                                │                                │
   │◄──────────── job {id, mint:1} ─│  pool below TOKEN_LOWWATER     │
   │                                │                                │
   │  runs the real widget locally ────────────────────────────────► │
   │◄───────────────────────────────────────── verification param ───│
   │                                │                                │
   │── WS captcha {id, param} ─────►│  stores it, asks Aliyun: valid?│
   │                                │───────────────────────────────►│
   │                                │◄──────────── {code:100} valid ─│
   │                                │  marks the donation verified    │
   │◄────────────── pong (25s) ─────│  keeps the socket alive         │
```

The client sends `{type:'captcha', id, param}` or `{type:'error', id, message}`.
Nothing else is accepted from it. The hub never trusts a param because a browser
said so — the Aliyun round trip is what decides `valid` / `invalid`.

The donation ledger behind `POST /tokens` keeps at most 200 fingerprints, because
`/tokens?all=1` serialises the whole list and it must not grow for the life of the
process; past that the oldest is dropped. A check fills it to prove the cap.

---

## What actually works

Each line was proven by a check in `npm run check` (347 assertions: 71 hub,
113 config, 9 multi-partner, 97 chat, 57 people). "Proven" means an assertion
fails if it stops being true.

**The spread - the core claim.** Three partners with different egress addresses
connect; all three get work; the split is exactly even; no job id is ever sent to
two partners at once; the pool stops exactly at its target and in-flight jobs
count against it. That is the whole reason the hub exists, and it is proven.

**Identity is real, not self-declared.** A key is checked in constant time, and a
signed HttpOnly cookie comes back. `/status` refuses you without an admin session
(401) and refuses the wrong role (403). The mint socket refuses an upgrade with
no session - `GLM_WS_AUTH=open` is the logged escape hatch.

**The browser flow was walked end to end, not just the API.** A real browser
signed in as partner on the front door (the key box appears only because the role
card stops the link - without `preventDefault()` the href won and nobody could
sign in), opened `/chat.html`, and talked twice through a local upstream stub:
turn 1 reached the upstream with 1 message, turn 2 with 3 (its own history plus
the ask) and was labelled `the hub continued this conversation`. Restarting the
hub and sending a third turn produced `404 · conversation gone` with the id still
on the page and a working "start a fresh conversation" button, and with no
upstream set the page quoted the `501` in full. `user.html` polled
`/status/self` and showed the hub's own numbers. Signing in with a name that is
not the key's owner was refused by the hub and quoted on the page ("that name
does not match the key presented"), and the same name with the person's own key
landed on their page with the bar reading `partner · carol`. That walk is
manual; the suites cover the same paths at the API level.

**A session expires on time, on the server.** `GLM_SESSION_TTL_MS` is checked
against the session's own age on every request, not left to the cookie: a raw
cookie header replayed past the TTL is refused, and a check starts the hub with a
700 ms TTL to prove it. Expired entries are swept on the `GLM_SWEEP_MS` interval
and counted in `/status.expiredSessions` instead of accumulating for the life of
the process.

**A socket that closes is noticed, whoever closed it.** The WebSocket helper keeps
"stop writing" and "the owner has been told" as separate flags, because sharing one
meant a graceful close — the ordinary case, a tab shutting — silenced the hub's own
bookkeeping: the partner stayed online forever and a job in its hands waited out
`JOB_TIMEOUT_MS`. A check closes a socket normally and proves the partner goes
offline, and that a job in flight is freed at once rather than after the timeout.

**Config is not baked in.** Captcha scene/prefix/appkey/region/language/sdk,
FE version, upstream origins, model bases, pool sizes, session lifetime and the
IP-lookup service all come from the environment. With nothing set, the hub
answers with the values the original capture used, so a plain checkout behaves
as recorded. The browser takes its captcha config from `GET /config`.

**Addressing survives deployment.** The address the pages and snippets show is
derived from the request's `Host` header, so a VPS shows its own name with no
configuration. Behind a proxy, set `GLM_PUBLIC_URL`; set `GLM_TRUST_PROXY=1` only
if you are behind one, because otherwise any visitor can make the panel print an
address of their choosing.

**Roles are kept apart.** The sign-in page is the front door. The hub writes a
navigation bar into each page listing only that role's links, and redirects a
signed-in visitor away from another role's page with `?wrongrole=`, so nobody is
one wrong click from the other side's screens.

**Model catalog and forwarding.** 32 ids by default — 4 bases × 2 sources × 4
suffixes — of the shape `<source>/<base>[-suffix]`, growing as `GLM_MODEL_EXTRA`
adds bases. With `GLM_UPSTREAM` set, chat forwards there — the model id still
picks the path, so `cn/…` keeps its own endpoint — signs each request, and
spends one pool entry on it; without it, `/v1/chat/completions` answers **501
with the reason** instead of faking success. The call is proven against a local
stub (`check-chat.mjs`), not against the real service.

**The pool is now spent.** A minted param leaves the pool on the chat path and
rides the upstream request as `captcha_verify_param`. A 401/403/429 puts it back
at the head instead of burning it, and the refund also backs `chat.poolSpent`
down - before that fix the panel's "entries spent" number could only climb, so it
drifted above reality for good. An empty pool still forwards but labels the
response `x-glm-pool: empty`, and `/status` counts `pool.consumed` and
`chat.poolSpent` as the entry goes.

**One caller, four requests, then a wait.** `GLM_CHAT_CONCURRENCY` (default 4)
caps chat requests in flight per identity — a named person, else the role, else
the client IP when nobody is signed in — and the request past the cap gets **429**
with `retry-after` plus `{type:"rate_limit_error", limit, retry_after_seconds}`.
The refusal happens before `consumeToken()`, so it spends no pool entry. That
caller then waits `GLM_CHAT_COOLDOWN_MS` (default 5000) before it may try again,
and a retry inside the wait is refused too — a client that ignores the 429
cannot spin. Slots are released in a `finally`, so an upstream error or a
timeout gives the slot back rather than locking the caller out. `/status`
reports `chatLimit` (the two numbers, `inFlight`, `callers`) and
`chat.throttled`. This is per caller, not a global limiter: two people behind one
NAT share an IP budget, and a second identity is a second budget.

**A donation flood is capped, and still buys nothing.** Every captcha-shaped
donation is one outbound Aliyun exchange, so `POST /tokens` counts how many each
caller has verifying (`GLM_DONATE_CONCURRENCY`, default 4) and answers **429** +
`retry-after` past it. The refusal lands before the donation is recorded and
before the exchange starts, so a refused value leaves no row and makes no call.
Values that are not captcha-shaped never reach the network at all — the cap only
bites someone sending something that looks like a real param. The slot is held
for the exchange, not for the request (the response goes out first), so it is
released in a `finally` on `verifyDonation`. `/status.donationLimit` reports
`concurrency`, `verifying`, `callers` and `throttled`. What this does **not** do
is turn a donation into capacity: donations are verified and recorded, never
replayed upstream, so a partner pasting a thousand z.ai or chatglm.cn sessions
adds zero chat throughput and mostly settles as `invalid`.

**The model id is a rule, not a list; every chat is attributable.** The upstream
keeps growing its own model names, so the suffix is stripped from the right:
`z.ai/glm-5.3-max-think` means source `z.ai`, base `glm-5.3-max`, thinking on —
forwarded even though no catalog entry exists, and labelled
`x-glm-model-known: false` so a typo is visible instead of silently "known".
Three guards keep that from meaning "forward anything": the source must be one
this hub speaks, an unknown base must start with `glm`, and `GLM_MODEL_EXTRA`
pins any other name exactly (an exact catalog id wins, so a base that genuinely
ends in `-think` is never re-split).

**Any role can supply the upstream credential, and the reply says which did.** A
signed-in visitor contributes a bearer token for `z.ai` or `cn` at
`POST /upstream/keys`. The gate runs in a fixed order — shape, then the JWT
claims offline (`exp` in the future, `id`/`sub` captured), then a duplicate
check, then one signed 5 s probe — and stores the outcome as `ok`, `unverified`,
`refused` or `dead`, never as "valid" when the probe could not run. The token
lives in memory only: it is never written to `GLM_STATE_FILE` (the file's
`tokens` array is the captcha pool, a different and single-use thing), never
logged, and never returned by any route — `/status.upstreamKeys` and
`/status/self.myKeys` publish an 8-char id, the source, the contributor, the
uses and the health, and a check asserts the token string appears in neither.
The chat forward prefers a pool token for the destination source over
`GLM_UPSTREAM_KEY`, retries once with the next credential when the upstream
refuses a pool one (`401/403/429`), holds that token dead for ten minutes, and
labels the answer `x-glm-key: pool | pool-unverified | env | none`.

**Egress can go through SOCKS5 and always says so.** `server/socks5.mjs` is a
hand-written client (no dependencies): the chat forward and the key probe take a
route per call from `GLM_EGRESS_ROUTES`, a failed handshake marks that route
dead for `GLM_EGRESS_DEAD_MS` and retries once on the next live route, and with
every route dead the call still goes out — direct, labelled
`x-glm-egress: direct-fallback`, one log line rather than one per request.
Captcha verification and the donation exchange stay direct on purpose, because
the widget breaks behind a proxy. What it is not: a Tor client (point a route at
a local Tor SOCKS port and only the address changes) and not volunteer routing —
a user's offered IP is reported, never used.

**A conversation resumes, and only for its own caller.** The hub mints the
`chat_id`, returns it as `x-glm-chat`, and continues that conversation when the
id comes back — replaying the turns it relayed (`GLM_CHAT_KEEP_CHARS`, 6000,
oldest dropped first, a leading system message kept), so a client that sends
only its new line still has the topic, while a client that sends its whole
history is taken at its word and not duplicated. The row is bound to the
caller's 8-hex HMAC tag, and an id belonging to somebody else gets the same
`404` as an id that never existed, so it is not a probe. That is what makes two
callers unable to bleed into each other on one shared upstream credential. One
turn at a time: a second request on a conversation whose first is still in flight
gets `409` `chat_busy`, because two would each be built without the other's reply
and then overwrite each other's turns. Each
reply carries `x-glm-chat`, `x-glm-caller`, `x-glm-caller-kind` and
`x-glm-chat-continued`; the tag, never the name, rides upstream as
`x-glm-caller`. `/status.chatLedger.recent` maps the last 20 ids back to their
identity and reports the **turn count**, never the text. The honest limits:
conversations are in memory, so a restart answers `404` and the client starts
fresh, and 200 conversations is the ledger — the oldest is evicted, including
someone else's, so a caller who churns chats evicts them; anyone who shares one
person's key is that person; and the tag proves which hub user a chat belongs to
— it cannot make one upstream account into many.

**Identity is revocable at runtime.** A superadmin creates a person
(`POST /people`) and sees the key once. An admin revokes or rotates
(`POST /people/revoke`, `POST /people/rotate`): the key stops working on the
next request, and the person's live sessions and open mint sockets are dropped
with it — "revoked" means revoked, not "until you reload". With
`GLM_STATE_FILE` set the directory is a JSON file written on every change, so
both a created person and a revocation survive a restart. A key pinned in the
environment cannot be revoked through the API, on purpose: the environment wins,
or a stale file could resurrect a key someone deliberately removed.

**No key is stored, only its hash.** Every person — the seeded superadmin
included — keeps a `scrypt` hash with a per-person salt, so a copy of the state
file is a list of names, not a set of credentials. A `version: 1` file that
still has plaintext keys is hashed and rewritten the first time the hub reads
it. Sign-in compares hashes in constant time. What this does *not* do is protect
the key on the wire: it is posted to `/session` in the request body, so you need
TLS in front of the hub before anyone signs in from another machine. The session
cookie is not a key either — it is a random id the server looks up, so a leaked
cookie cannot be replayed as a key after revocation. The minted pool entries are
the one thing that cannot be hashed at all: they are live captcha parameters
that must be replayed to upstream verbatim, so they are written as they are —
but only while they live (inside their half-hour TTL), only in the same `0600`
file, and only when `GLM_STATE_FILE` is set. Bearer tokens contributed to the
shared upstream pool are the opposite: an account credential that is never
written anywhere, by design.

---

## What has been closed

Each record names the date, the command, and the evidence - a gap is deleted
here only when a check can fail if the behaviour breaks.

**2026-11-22 - the minted-token pool survives a restart** (was gap 4).
`loadState`/`saveState` carry a `tokens` array beside `people` in the same
`0600` document: written on mint, on consume, on refund, and only when
`sweepPool` actually moves something; filtered to entries still inside their
TTL; dropped on load when already expired, with the count logged as
`pool: N token(s) loaded ..., M expired on the way`. Sessions, jobs, the donation
ledger, the chat ledger and contributed bearer tokens stay in memory on purpose.
Proof: `check-config.mjs` section G, 12 assertions - two params minted over the
real socket and back after a restart with the same ids, an expired entry not
counted and counted as expired, a people-only file still loading. Run:
`node check-config.mjs` -> `config check: all expectations met`, exit 0.

**2026-11-22 - egress can go through SOCKS5** (was gap 5).
`server/socks5.mjs` is a hand-written client (no auth, domain CONNECT, no
dependencies); the chat forward and the upstream-key probe choose a route per
call, a failed handshake marks that route dead for `GLM_EGRESS_DEAD_MS` and
retries once on the next live route, and every chat reply carries
`x-glm-egress: proxy|tor|direct|direct-fallback`. `POST /captcha/verify` and the
donation exchange stay direct, because the captcha breaks behind a proxy. No Tor
client ships - a real circuit only changes the address. Proof: `check-chat.mjs`
phase 7, 11 assertions against an in-file SOCKS5 stub that records the CONNECT
target and forwards - a routed call labelled `proxy`, a route that cannot
handshake still succeeding labelled `direct-fallback`, a dead route not dialled
twice, `/status.egress` reporting routes and dead. Run: `node check-chat.mjs` ->
97 ok, 0 fail, exit 0.

## What is not done yet

Ordered by how much they block real use. Each one has a runbook: the commands,
what a pass looks like, and where to record it. Every step is something one
person with a browser and a terminal can do in an afternoon — none of them
needs a change to the design.

**Start with `node doctor.mjs`.** It reads this list, says what each gap needs,
reports what this machine already has (an upstream, a key, a state file), and
prints the next command. With `GLM_UPSTREAM` and `GLM_UPSTREAM_KEY` set,
`node doctor.mjs live` starts its own hub on a spare port, makes one real call,
prints `PROVEN` (or the exact status and body that refused it), and kills the
hub — the mechanical half of gaps 1, 3 and 5 without curl or a cookie jar.
Everything it prints is a probe, not a closure: the record below still decides.

**How to record a closure.** When a runbook passes, add the date, the exact
command, and the observed answer under that gap (a line or two, pasted output
is better than a description), then delete the gap and lower the numbered-gap
floor in `check-docs.mjs` in the same edit — that floor is a tripwire for gaps
disappearing by accident, not a rule against closing them. If a runbook fails,
record the failure instead: "`401 USER_BLOCKED` on 2026-11-21" is worth more to
the next person than silence.

### 1. Upstream forwarding has never reached the real service

The whole path is proven against a local stub instead of an unreachable host:
`GLM_UPSTREAM` really redirects the destination (the source in the model id
still picks the path, so `cn/…` keeps its own endpoint), the credential rides as
a bearer token, `x-signature` is a real HMAC over the flattened prompt, and the
suffix features arrive in the reference projects' `features` shape
(`check-chat.mjs`, 97 assertions). But it has **never made a successful call to
chat.z.ai or chatglm.cn**, because no real credential has been tried.

The credential has two sources now, and neither one is the operator's alone: a
signed-in visitor can contribute a bearer token to the shared pool
(`POST /upstream/keys`, validated by shape, then JWT claims offline, then one
signed probe), and `GLM_UPSTREAM_KEY` remains the environment's own. Which one
answered is on every reply as `x-glm-key: pool | pool-unverified | env | none`.

_Close it by:_ contributing a real token (or setting `GLM_UPSTREAM` and
`GLM_UPSTREAM_KEY`) and asserting a completion comes back. Until then treat the
happy path as untested against the real service.

Quickest path: with those two variables set, `node doctor.mjs live` does the
hub start, the call and the verdict for you (steps 2 and 3 below), prints
`PROVEN` or the exact status and body that refused it, and kills its own hub.
The steps below are still what you record.

1. Get an account token. Sign in to the upstream in a browser, open devtools →
   Network, send one chat message, and copy the `Authorization: Bearer …` value
   from that request. That token _is_ `GLM_UPSTREAM_KEY`; it is somebody's
   account credential, so pass it by environment variable and never commit it.
2. Start the hub against the real origin (`GLM_UPSTREAM` is an origin, not a
   full URL — the path comes from the source in the model id):
   ```powershell
   $env:PORT='5240'
   $env:GLM_UPSTREAM='https://chat.z.ai'
   $env:GLM_UPSTREAM_KEY='<the bearer value>'
   node server/hub.mjs
   ```
   The startup line prints `upstream: https://chat.z.ai (with a key)`. If it
   says `(no key)`, the variable did not reach the process.
3. Call it:
   ```powershell
   curl.exe -s -i http://127.0.0.1:5240/v1/chat/completions `
     -H 'content-type: application/json' `
     -d '{"model":"z.ai/glm-5.3","messages":[{"role":"user","content":"say ok"}]}'
   ```
4. **What a pass looks like:** `HTTP/1.1 200`, a JSON body with a completion,
   `x-glm-key` naming the credential that answered (`pool`, `pool-unverified`,
   `env` or `none`), `x-glm-pool: spent` (or `empty` if the pool had nothing —
   that is labelled, not hidden) and `x-glm-egress` saying whether the call went
   `direct` or through a route. A `502` means unreachable, a `501` means no
   destination was configured, and an upstream error body means the credential or
   signature was refused — record the exact code and message.
5. Two outcomes are legitimate and both should be recorded: the upstream may
   accept a call with no `captcha_verify_param` (then gap 1 is closable alone),
   or it may insist on one (then run gap 2 first and repeat this step with a
   minted param in the pool).

### 2. The captcha mint has never been proven against the real widget

The hub verifies donations against Aliyun, and the client loads the real SDK when
a hub is present — but no automated run has captured a genuinely minted
parameter from the live widget. Where no hub answers, the page runs a clearly
labelled demo instead.

_Close it by:_ running the minter in a real browser against a live hub and
asserting a `valid` verification comes back.

1. Start a hub on a spare port and keep its output visible:
   ```powershell
   $env:PORT='5241'
   node server/hub.mjs
   ```
   Note the keys it prints (or set `GLM_KEYS` beforehand so you choose them).
2. Open `http://127.0.0.1:5241/`, sign in as a partner, and let it land on
   `public/index.html`. Leave that tab open — the socket is the whole point.
3. Open devtools → Network → WS → `/minter/ws` → Messages. You should see the
   page send `{"type":"hello",…}` and the hub send `{"type":"job",…}`, then the
   page answer `{"type":"captcha","id":…,"param":…}`. That `param` is the first
   real mint this project has seen.
4. Confirm the hub counted it: sign in as admin in a second tab and watch
   `minter.served` under `/status` (or the panel's Served row) rise. `served >= 1`
   with `inflight` returning to 0 is the round trip.
5. Exchange that param with Aliyun, which is what turns "a param arrived" into
   "the param is good":
   ```powershell
   curl.exe -s -c cookies.txt http://127.0.0.1:5241/session `
     -H 'content-type: application/json' `
     -d '{"role":"admin","key":"<admin key>"}'
   curl.exe -s -b cookies.txt http://127.0.0.1:5241/captcha/verify `
     -H 'content-type: application/json' -d '{"param":"<the minted param>"}'
   ```
6. **What a pass looks like:** `{"ok":true,…,"status":"valid"}` (Aliyun's code
   100). `invalid` means the widget answered but the value was not accepted —
   still a real finding, record it. `unverified` with a network reason means the
   machine could not reach Aliyun; that is not a pass.
7. Record: the date, the port, `served` at the time, and the verify answer. The
   demo path in `public/minter.js` must then be described as a fallback only —
   never as evidence.

### 3. Suffix features are declared, not exercised upstream

`-think`, `-search`, `-deepresearch` rewrite the model id and set the flags in
the shape the reference projects send (`enable_thinking`, `web_search`,
`auto_web_search`), proven at the request body. The admin panel's toggles are
defaults for every request, OR'd with the suffix, so a suffix can turn a feature
on but never off - proven to reach the wire, and proven that clearing a default
turns it back off. What no check can show is what the real service _does_ with
them: nothing here has called the upstream.

_Close it by:_ the same credential as (1), one call per suffix, recorded.

`node doctor.mjs live z.ai/glm-4.7-think` (and the same for `-search` and
`-deepresearch`) makes each call and prints the reply, so step 1 below is one
command per suffix. What the reply *means* is still the judgement call in step 2.

1. With gap 1's hub still running, make three calls and keep each body:
   ```powershell
   foreach ($m in 'z.ai/glm-5.3-think','z.ai/glm-5.3-search','z.ai/glm-5.3-deepresearch') {
     curl.exe -s http://127.0.0.1:5240/v1/chat/completions `
       -H 'content-type: application/json' `
       -d ('{"model":"' + $m + '","messages":[{"role":"user","content":"what changed in Rust 1.90"}]}')
     "`n--- $m`n"
   }
   ```
2. **What a pass looks like:** each reply shows the feature _acting_, not just
   the flag riding along — a reasoning/thinking block for `-think`, cited
   results for `-search`, a research plan or task object for `-deepresearch`.
   A reply that is identical in shape to the plain model means the upstream
   ignored the flag; that is a finding too, and it changes the claim from
   "declared" to "declared and ignored by this upstream".
3. Record one line per suffix: what was asked, what came back, and whether the
   feature visibly fired. Then `GET /v1/models` stops needing the
   `declared_only: true` label for that source — but only then.

### 4. Two behaviours are unverified

- **Background-tab survival.** The silent-oscillator technique is reproduced
  faithfully; whether it actually keeps the tab alive is unobserved.
- **Phone-width likeness.** 98–100% layout match at 1440 and 768 px; ~86–98% at
  390 px, which is weaker than desktop.

_Close them by:_ a long-run tab test, and a pixel comparison at 390 px.

1. Background tab: start a hub (port 5242, `PUMP_MS=1000` so there is constant
   work), open the minter in a tab, then switch to another tab or minimise the
   window and leave it for at least 30 minutes. Read `/status` as admin
   occasionally; you are looking for `minter.served` climbing and `minter.online`
   staying at 1 the whole time.
2. Also read the hub's own log: one `connected as` line at the start and no
   reconnect lines means the socket never dropped. Repeated `connected as` lines
   with matching `disconnected` lines mean the tab was throttled and the page's
   backoff reconnected — that is the interesting result, not a failure.
3. Record: minutes observed, `served` before and after, and the reconnect count.
4. 390 px: open the reference upstream page and `public/index.html` side by side
   in a real browser at 390×844, screenshot both, and diff them. Record the
   percentage and the specific elements that differ (the earlier numbers came
   from the same method at 1440 and 768). A single number with no diff image is
   not evidence — attach or name the file next to the note.

### 5. Only one token source is modelled end to end

Both `chat.z.ai` and `chatglm.cn` have origins and model ids, and the redirect
keeps each one's own path — but the collector work and the reference projects
centre on z.ai. Whether chatglm.cn issues usable tokens the same way is
untested.

_Close it by:_ one live capture against chatglm.cn with a credential, recorded
alongside the z.ai one.

`node doctor.mjs live cn/glm-4.7` runs the call in step 3 once the token is set
— if the model id and the origin disagree you will see the path in the error
body, which is the finding.

1. Repeat gap 1's token capture on chatglm.cn instead: same devtools method, same
   `Authorization` header, and note whether the token is a JWT (the hub needs the
   `id` claim for `x-signature`; a non-JWT yields an empty account id, which the
   reference projects also tolerate).
2. Point the hub at it — the `cn/` prefix keeps the source's own path, so only
   the origin changes:
   ```powershell
   $env:GLM_UPSTREAM='https://chatglm.cn'
   $env:GLM_UPSTREAM_KEY='<the chatglm.cn bearer value>'
   ```
3. Call it with a `cn/` model id:
   ```powershell
   curl.exe -s -i http://127.0.0.1:5240/v1/chat/completions `
     -H 'content-type: application/json' `
     -d '{"model":"cn/glm-5.3","messages":[{"role":"user","content":"say ok"}]}'
   ```
4. **What a pass looks like:** the request reached `chatglm.cn/api/v1/chat/completions`
   (the path is in the error body if it did not), and a completion came back.
5. Record: which source the token came from, whether it is a JWT, the status,
   and whether the same token works for both sources or only its own. That last
   answer decides whether one credential can serve both — which nothing here
   currently assumes.

---

## Before you change anything

**Traps that have already bitten someone.**

1. **`/` is not the minter.** It redirects to `login.html`, or to your own page if
   you are signed in. The captured page is `/index.html`. Any check or link that
   assumes `/` serves it will be wrong.

2. **`minter.html` does not exist.** The minter page is `index.html`.

3. **The nav bar is written by the hub, not by a script.** `<!--nav-->` in each
   HTML file is a slot the hub fills in `serveStatic`. Consequences:
   - Viewed as a plain file, the marker is an HTML comment and renders as
     nothing — that is intentional, a static host has no hub.
   - A page with no marker is served untouched, so you cannot break a file by
     forgetting one.
   - If you ever see raw `<!--nav-->` _text_ in a browser, the hub failed to fill
     it — that is a bug, and the suite asserts it does not happen.

4. **Hiding a link is not access control.** The bar shows one role's links; every
   route still enforces its own role. Never move a permission check into the
   navigation.

5. **Restarting the hub invalidates the pool and every session.** Generated
   role keys die too; the people directory and the seeded superadmin do not,
   because their hashes are in `GLM_STATE_FILE`. Pin `SESSION_SECRET` to stop
   every restart logging everyone out.

6. **`GLM_TRUST_PROXY=1` in front of the open internet** lets a visitor forge
   `X-Forwarded-Host` and make the panel print any address they like. Only set it
   behind a proxy you control.

7. **The honest-degrade rule.** Where something cannot be done, refuse and say
   why (501 with its reason, `unverified` rather than `valid`, a demo labelled as
   a demo). Do not replace a refusal with an optimistic success. Several checks
   assert this and will fail you.

8. **Zero dependencies, and files only under `app/`.** No `npm install` may
   become necessary. `build.mjs` refuses if any server code reaches `dist/`.

9. **The ALIYUN appkey is public by design.** It ships to every browser in the
   widget. Do not treat it as a secret, and do not "fix" it by hiding it — that
   would break the widget.

10. **One hub per state file.** `GLM_STATE_FILE` is saved whole (read the
    directory, rewrite it), so two hubs pointed at one file — a blue/green pair, a
    cluster behind a load balancer — silently lose whichever person the other
    process did not have in memory. The chats are worse than that: they are
    per-process, so a conversation started on hub A answers **404** on hub B.
    Run one hub, and scale by putting more load on it, not by starting a second.

11. **The frontend is not compiled, on purpose.** No TypeScript, no bundler, no
    build step between `public/*.js` and the browser — the file you read is the
    file that runs, which is what makes the browser failures above traceable.
    Types arrive as JSDoc instead: all six scripts open with `// @ts-check` and
    are checked by `check-types.mjs` with `tsc --strict` when one is on PATH,
    skipped (loudly) when not. That skip is the rule, not an oversight:
    `npm run check` must stay green on a machine with no TypeScript. The ratchet
    is per file — the checker only looks at files that opt in — so a new script
    joins by adding the comment and a `@typedef` for the wire shape it reads.
    A real `.ts` migration means a compiler on every machine that runs this, so
    don't start it in passing.

    Worth knowing: TypeScript would **not** have caught the `personname` bug
    (a script reading an id no page defines) — `getElementById` returns
    `HTMLElement | null` either way. `check-html.mjs` catches that now, by
    comparing every id a script reads against the ids the pages and the
    run-time widgets define. What the JSDoc does catch is a field name: `tsc`
    rejects `o.sentID` and `you.adress` with a "did you mean" — both of those
    would otherwise have rendered a dash and said nothing.

---

## Verifying

```bash
npm run check
```

Nine suites and the doctor's self-test, all must exit 0:

| Suite                 | Assertions           | Covers                                                                                                 |
| --------------------- | -------------------- | ------------------------------------------------------------------------------------------------------ |
| `check-html.mjs`      | —                    | tags balanced and properly nested, and every id a script reads is defined by a page or made at run time |
| `check-types.mjs`     | —                    | all six scripts in `public/` type-check clean under `tsc --strict` (skips loudly when no tsc is installed) |
| `check-links.mjs`     | 37 links + 6 anchors | every local reference **and** every `#anchor`, in-page and cross-page                                  |
| `check-hub.mjs`       | 71                   | routes, auth, donations, the donation cap, verification, nav, gate, `/status/self`                     |
| `check-hub-multi.mjs` | 9                    | the even spread across three partners                                                                  |
| `check-config.mjs`    | 113                  | env-driven config, deployment addressing, role separation, server-side session expiry, the chat page, a pool that survives a restart |
| `check-chat.mjs`      | 97                   | forwarding, request signing, pool spend and refund, feature defaults, empty-pool labelling, the per-caller 429, the model rule, the conversation tracer, the contributed-key gate, SOCKS5 routing and its labelled fallback |
| `check-people.mjs`    | 57                   | create / revoke / rotate, live sessions and sockets dropped, the state file, hashing at rest, the seeded superadmin across a restart, a v1 file upgraded |
| `check-docs.mjs`      | 27                   | this note, the README and the newcomer page against the tree: settings, paths, stale claims, the gap-list floor, the .env template, counts that must agree |
| `doctor.mjs --self-test` | 9                | the report reads this note honestly: gap count, a closing step per gap, a key never printed, 200 the only "proven" |

`check-chat.mjs` starts its own local stub for the upstream, so the whole chat
path runs without a credential or the internet — the one part of forwarding that
can be proven without an account. `check-hub.mjs` does the same for the Aliyun
verify endpoint (a stub that answers `code 110` after a delay), which is how the
donation cap is observed without a network.

`check-links.mjs` validates anchors too — it used to strip them, which silently
unchecked the deep links from the admin gaps table into `repos.html`. If you add
an anchor, add the link that uses it; the suite now catches a rename.

---

## Where to look

```
server/hub.mjs        everything server-side: config, sessions, roles, routes,
                      the nav bar, static serving. Biggest file; start here.
server/ws.mjs         hand-written RFC 6455 WebSocket server.
public/index.html     the rebuild of the captured page (the minter).
public/minter.js      its behaviour: socket, jobs, background mode, IP lookup.
public/glm-client.js  the captcha client: SDK loading, minting, signing.
public/login.html     the front door: role picker.
public/chat.html      the chat page every signed-in role gets.
public/chat.js        its behaviour: catalog, one turn at a time, chat-id resume.
public/admin.html     the operator panel.
public/partner.html   the partner's page: donations and their status.
public/user.html      the user's page: what the hub can prove about this address.
public/user.js        its 5 s poll of /status/self.
public/roles.js       shared browser helpers: IP, sign-in, notes, logging.
public/repos.html     the three reference projects, dissected.
public/minter.css     the original's design tokens; also the nav bar's styles.
check-*.mjs           the suite.
START-HERE.md         the orientation page (read before this note).
Dockerfile            one always-on image; .dockerignore keeps secrets out of it.
.repos/               downloaded reference sources — never published.
```

`README.md` is the long version: every route with its auth requirement, every
environment variable with its default and the reason for it, and the mint
protocol written out as a message diagram.

## The reference projects

`repos.html` dissects all three. In one line each:

- **pingmike2/zai2api** — Go, one binary, SQLite token store consumed FIFO,
  in-process Aliyun captcha, one static proxy. Shorter: read it first.
- **D3-vin/GLM-ZAI-2API** — most complete: three protocols, vision, tool calling,
  browser TLS fingerprint, account pool with rotation, rotating WAF proxies,
  in-process captcha.
- **chaoticmindv/zai2api** — Node rewrite for Windows; Playwright stealth
  collector harvests device tokens into SQLite.

None of them has a partner surface, a page a third person opens, or work spread
across several contributed egress points. That is the gap this project fills.
Nothing here needs them at runtime — they are reference reading.
