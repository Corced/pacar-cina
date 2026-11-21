# Hand-off note

Everything you need to pick this up without reading the whole `app/` tree.
Written for someone who did not build it. Maintained by **Corced**.

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
npm run check     # the whole test suite (see Verifying)
```

Open the hub's address. You land on the sign-in page — that is deliberate, `/`
redirects there. Keys are printed to the console at startup when you have not
set any; the `user` role needs no key.

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

Each line was proven by a check in `npm run check` (266 assertions: 66 hub,
97 config, 9 multi-partner, 38 chat, 56 people). "Proven" means an assertion
fails if it stops being true.

**The spread - the core claim.** Three partners with different egress addresses
connect; all three get work; the split is exactly even; no job id is ever sent to
two partners at once; the pool stops exactly at its target and in-flight jobs
count against it. That is the whole reason the hub exists, and it is proven.

**Identity is real, not self-declared.** A key is checked in constant time, and a
signed HttpOnly cookie comes back. `/status` refuses you without an admin session
(401) and refuses the wrong role (403). The mint socket refuses an upgrade with
no session - `GLM_WS_AUTH=open` is the logged escape hatch.

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
that must be replayed to upstream verbatim. They stay in memory, expire in half
an hour, and are never written to disk — which is why gap 4 keeps them out of
the state file.

---

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
hub — the mechanical half of gaps 1, 3 and 7 without curl or a cookie jar.
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
still picks the path, so `cn/…` keeps its own endpoint), the key rides as a
bearer credential, `x-signature` is a real HMAC over the flattened prompt, and
the suffix features arrive in the reference projects' `features` shape
(`check-chat.mjs`, 38 assertions). But it has **never made a successful call to
chat.z.ai or chatglm.cn**, because no credential was ever supplied.

_Close it by:_ setting `GLM_UPSTREAM` and `GLM_UPSTREAM_KEY` to a real account,
then asserting a completion comes back. Until then treat the happy path as
untested against the real service.

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
   and the response header `x-glm-pool: spent` (or `empty` if the pool had
   nothing — that is labelled, not hidden). A `502` means unreachable, a `501`
   means the variable never arrived, and an upstream error body means the
   credential or signature was refused — record the exact code and message.
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

### 4. Everything outside the people directory is still memory

The **people directory is now a file** (`GLM_STATE_FILE`): created people, their
roles and their key hashes survive a restart, and a revocation survives it too.
The seeded superadmin is in the same file, so its key survives a restart without
`GLM_SUPERADMIN` being set. That was the only part worth keeping. The rest stays
in memory on purpose: pool entries are captcha params that expire in half an
hour, so writing them to disk is a liability with no payoff, and sessions dying
on restart is a feature rather than a bug.

_Close it by:_ only if you disagree — a `GLM_STATE_FILE`-backed pool and
donation log would be the same `savePeople()` pattern, at the cost of holding
short-lived credentials on disk.

1. Decide first, because this is a deliberate refusal rather than a missing
   feature: what does a restart currently cost you that a file would fix? If the
   answer is "the pool has to refill", note that refilling is what the partner
   browsers are for and it takes minutes, while a file would put live captcha
   params on disk for anyone with read access to that path.
2. If you still want it: copy the `loadPeople`/`savePeople` pair in
   `server/hub.mjs` for `state.tokens`, call it from `consumeToken`, `sweepPool`
   and the mint path, and refuse to load entries whose `expiresAt` has passed.
3. Add to `check-config.mjs`: write two entries, restart the hub, assert they
   are back, then assert an expired one is not. That is the only way this change
   is safe — a stale param on disk is worse than an empty pool.

### 5. Egress routing is a toggle; there is no Tor

A user can offer their IP and the setting is remembered, but **no traffic is
routed through it**, and there is no Tor client — only a row in the panel.

_Close it by:_ a real routing decision per outbound call, then a SOCKS5 client.
Note: **none of the three reference projects has Tor**, so there is nothing to
copy. The nearest pattern is D3-vin's dead-proxy TTL bookkeeping, and its
`proxy.txt` one-address-per-line shape suits a circuit list.

1. Pick the seam: the chat forward in `server/hub.mjs` uses `fetch`, and Node's
   `fetch` takes no proxy option. Either move that one call to `https.request`
   with a custom `createConnection`, or keep `fetch` and pass a dispatcher — but
   the second needs an `undici` import, which breaks the zero-dependency rule.
   The first is the honest option: a hand-written SOCKS5 client is a CONNECT
   handshake and a socket pump.
2. Implement it as one module in `server/` (no dependencies), and make the
   routing decision per request: `state.egress` says whether a user offered an
   exit, the source's policy says whether captcha traffic is exempt (the
   reference projects keep the captcha widget direct because it breaks behind
   proxies), and a dead route is marked dead with a TTL before it is retried.
3. Prove it without Tor: add a SOCKS5 stub to `check-chat.mjs` that accepts the
   handshake, records the CONNECT target, and forwards to the same local
   upstream stub the file already runs. Assert the chat call reached the target
   _through_ the stub, and that a route marked dead is skipped on the next call.
   That check is the whole feature; a real Tor circuit only changes the address.
4. Record: which calls now route, what the failure policy is, and what happens
   when every route is dead (it must be a labelled direct call or a refusal,
   never a silent one).

### 6. Two behaviours are unverified

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

### 7. Only one token source is modelled end to end

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

---

## Verifying

```bash
npm run check
```

Eight suites and the doctor's self-test, all must exit 0:

| Suite                 | Assertions           | Covers                                                                                                 |
| --------------------- | -------------------- | ------------------------------------------------------------------------------------------------------ |
| `check-html.mjs`      | —                    | tags balanced and properly nested                                                                      |
| `check-links.mjs`     | 33 links + 6 anchors | every local reference **and** every `#anchor`, in-page and cross-page                                  |
| `check-hub.mjs`       | 66                   | routes, auth, donations, the donation cap, verification, nav, gate                                      |
| `check-hub-multi.mjs` | 9                    | the even spread across three partners                                                                  |
| `check-config.mjs`    | 97                   | env-driven config, deployment addressing, role separation, server-side session expiry                  |
| `check-chat.mjs`      | 38                   | forwarding, request signing, pool spend and refund, feature defaults, empty-pool labelling, the per-caller 429 |
| `check-people.mjs`    | 56                   | create / revoke / rotate, live sessions and sockets dropped, the state file, hashing at rest, the seeded superadmin across a restart, a v1 file upgraded |
| `check-docs.mjs`      | 18                   | this note and the README against the tree: settings, paths, stale claims, the gap-list floor           |
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
public/admin.html     the operator panel.
public/partner.html   the partner's page: donations and their status.
public/user.html      the user's page: lend an IP.
public/roles.js       shared browser helpers: IP, switches, sign-in, notes.
public/repos.html     the three reference projects, dissected.
public/minter.css     the original's design tokens; also the nav bar's styles.
check-*.mjs           the suite.
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
