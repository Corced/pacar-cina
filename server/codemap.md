# server/

## Responsibility

The entire backend of glm2api: one Node process that serves the static site from
`public/`, authenticates roles, dispatches captcha-mint jobs to connected
browsers over a WebSocket, keeps an in-memory pool of donated/ minted values,
verifies captchas against Aliyun, and exposes an OpenAI-shaped chat surface that
forwards to z.ai / chatglm.cn when an upstream is configured.

`hub.mjs` is the whole server (config, identity, pool, job board, HTTP router,
static file serving). `ws.mjs` is a self-contained RFC 6455 server, written by
hand because the project has zero dependencies.

## Design

**Single-process, module-scope singleton.** All state lives in one `state` object
(partners, tokens, donated, people, sessions, jobs, counters) created once at
module load. There is no database, no request context object, no DI — handlers
are closures over module globals, and any handler can read/write any collection.

**Configuration as a constant layer.** `CONFIG` is built once from `process.env`
with the *captured original* values as defaults, so an unset environment behaves
exactly like the recorded upstream. Browser-visible values are echoed by
`GET /config`; nothing is baked into `public/`.

**Identity chain: key → role → person.** Three layers, deliberately separate:

- `KEYS` — one key per privileged role (`partner`, `admin`, `superadmin`), from
  `GLM_KEYS`, else generated at startup and printed once. `user` has no key.
- `checkKey(role, given)` — hashes the candidate with the person's salt and
  compares in constant time against the role key *and* every person holding that
  role. Missing key for a role means the role is open (only `user`); the top role
  is never open by accident.
- `state.people` — `name → {name, role, salt, hash, uses, pinned?}`; a person's key
  makes the session carry their name, which then rides on mint sockets and
  donations. Only an env-pinned person keeps the key itself, because the
  environment is its owner. Mutable at runtime: `loadPeople`/`savePeople` (JSON at
  `GLM_STATE_FILE`, `0600`, written on every change, `version: 2` with a separate
  `seed` block for the superadmin so a revoke cannot drop the account of last
  resort) and a key pinned in the environment always wins over the file, so a
  restart cannot resurrect a revoked key. A `version: 1` file is hashed and
  rewritten on load. `revokePerson` / `rotatePerson` delete the live sessions
  *and* close the open sockets too — without that, "revoked" would mean "until
  you reload".
- `ADMINISH` = `{admin, superadmin}`, and `isAdminish()` is what every privileged
  gate calls, never a string comparison.

**Sessions are HMAC-signed cookies backed by a Map, and the age is enforced
server-side.** `issueSession` signs `sid` with `SESSION_SECRET` (ephemeral when
unset, which invalidates every session on restart) and stores
`{role, name, created, lastSeen}` in `state.sessions`; `readSession` parses,
recomputes the HMAC, rejects a forged or edited cookie, looks the `sid` up, and
**refuses it once `now - created >= GLM_SESSION_TTL_MS`** — the cookie's `Max-Age`
is only a client-side hint, so without this a replayed raw cookie header would
authenticate forever. `sweepSessions` (called from the same `GLM_SWEEP_MS`
interval as the pool sweep) removes idle entries and counts them in
`expiredSessions`, so the Map does not grow for the life of the process. Deleting
a live entry is also what makes revocation immediate: a purely stateless cookie
could only be revoked by rotating `SESSION_SECRET`, which would log everyone out.
Cookie is `HttpOnly; SameSite=Lax; Path=/`. The socket upgrade reuses it - no
separate WS handshake token.

**The pool is a bounded queue with a life cycle and a consumer.** `tokens[]`
entries carry `expiresAt`; `sweepPool` moves expired ones into `expired`
(counted, never dropped silently); `refillPool` asks partners for work while
`tokens + inflight < TARGET` and `tokens < LOWWATER`; the sweeper interval also
tops up so an idle hub self-heals. `consumeToken()` (oldest first) is called by
`/v1/chat/completions`: the entry's `param` becomes the request's
`captcha_verify_param`, and a 401/403/429 or a network failure `unshift`s it back
so a bad credential never burns pool work.

**Job dispatch is least-recently-asked.** `pickPartner` filters to `state ===
'idle'` sockets with a live connection, sorts by `lastAsked`, takes the head.
That single sort is what makes the spread even — it is the project's core claim
and `check-hub-multi.mjs` asserts 10/10/10 across three partners.

**Server-rendered navigation as presentation, never access control.** `navFor`
maps a role to its links; `withNav` splices the bar into the `<!--nav-->` marker
in the HTML at serve time, so the correct menu is in the first paint. Every JSON
route independently enforces its own role — the bar is a map, not a lock.

**Honest degradation.** Where something cannot be done the hub refuses with its
reason rather than faking success: `501` with an explanation when `GLM_UPSTREAM`
is unset, `502` when the upstream is unreachable, `unverified` rather than
`valid` for a donation Aliyun did not confirm, `x-glm-pool: empty` when a
request had to go out with no captured param. Several checks assert this rule.

**Hand-written WebSocket framing.** `ws.mjs` implements the SHA-1 accept key,
frame encode/decode (7/16/64-bit lengths, masking), continuation-frame
fragmentation, ping/pong and close. It deliberately does *not* implement
extensions or permessage-deflate, so a browser never negotiates compression.

## Flow

**Sign-in.** `POST /session {role, key, name?}` → `checkKey` (role key or a
person key; person path also requires `body.key === owner.key`) → `issueSession`
→ `Set-Cookie: glm_sid=…` → the browser is now recognised by `readSession` on
every request *and* on the `/minter/ws` upgrade. A subsequent page load goes
through `serveStatic`: `readSession` → no session and not `isGateOpen` →
`302 /login.html?next=…`; session but a page owned by another role →
`302 <role home>?wrongrole=…`.

**Mint (the core loop).**

```
GET /minter/ws (upgrade)  → readSession; no session and GLM_WS_AUTH!=='open' → 401 + destroy
                          → 101 + attachSocket → onMinterSocket(conn, req, session)
client {type:"hello", ip, proto:2}  → partner registered, state 'idle'
                                      (ip from X-Forwarded-For or remote address)
dispatchJob()             → pickPartner() (least-recently-asked idle) →
                            guards tokens+inflight ≥ TARGET → stop;
                            else inflight++, state 'busy', JOB_TIMEOUT_MS timer,
                            send {type:"job", id, payload:{mint:true}}
client {type:"captcha", id, param} → finishJob('ok') → served++, partner.mints++,
                                      push {id, at, expiresAt, partnerId, size},
                                      refillPool(), then dispatch next after 50 ms
client {type:"error", id, …}       → finishJob('error') → failed++
JOB_TIMEOUT_MS fires               → inflight--, failed++, partner back to 'idle',
                                     jobs entry deleted
close (client, revoke, or our own) → onClose runs once → state 'gone', socket nulled,
                                     that partner's jobs failed at once
{type:"ping"} ↔ {type:"pong"}      → liveness (client pings every 25 s)
```

`PUMP_MS` (default 8 s) re-dispatches while the pool is under target, so a hub
with connected partners keeps filling even with no other traffic.

**Chat.**

```
POST /v1/chat/completions → readBody → resolveModel(model)
   null            → 400 with the catalog shape and a pointer to GET /v1/models
   no UPSTREAM.url → 501 {type:'not_implemented', resolved_model}
   else            → dest = GLM_UPSTREAM || SOURCES[source] (path always from
                     the source, so cn/ keeps /api/v1);
                     spent = consumeToken() — oldest first;
                     body: model=plain base, chat_id, messages, signature_prompt
                     (flattened), stream, captcha_verify_param=spent.param,
                     features{image_generation, web_search, auto_web_search,
                     preview_mode, flags, enable_thinking} from the suffix;
                     headers: authorization, x-fe-version, x-region,
                     x-signature = signZai(prompt, key) (HMAC-SHA256 over a
                     bucketed key, requestId/timestamp/user_id + base64 prompt);
                     AbortController at UPSTREAM.timeoutMs;
                     401/403/429 → unshift the entry back (unspent), respond
                     with the upstream status; success → respond and return
                     (must not fall through to serveStatic); network error →
                     502 with the entry restored. Always answers x-glm-pool:
                     spent|empty.
```

`resolveModel` makes `CATALOG` entries (`<source>/<base>[-suffix]`) the authority
and treats bare bases (`glm-4.7`) as aliases for their z.ai id.

**Donation.** `POST /tokens {kind, value}` → partner/admin gate → SHA-256
fingerprint (16 chars) → duplicate short-circuit → push `{kind, fp, person,
role, status:'verifying'}` → `verifyDonation` runs *off* the request path and
settles the status from the real Aliyun answer; the raw value is never stored on
the donation, so a later `POST /captcha/verify {fp, value}` must re-supply it.
The ledger holds at most 200 entries (`/tokens?all=1` serialises all of it, so it
must not grow for the life of the process); the oldest is dropped past that.

## Integration

Route table. "session" = any signed-in role; "adminish" = `admin` or `superadmin`.

| Method | Path | Auth | Consumers |
|---|---|---|---|
| WS | `/minter/ws` | session (or `GLM_WS_AUTH=open`) | `public/minter.js` |
| POST | `/session` | role key (user: none) | `roles.js` (`signIn`), `admin.js` (`grabKey`) |
| GET | `/session` | open | `roles.js` (`hub()` probe) |
| GET | `/config` | open | `glm-client.js`, `roles.js` (IP lookup URL) |
| GET | `/status` | adminish | `admin.js` (5 s poll) |
| GET | `/status/self` | session | minter's no-hub probe / partner pages |
| POST | `/tokens` | partner, adminish | `roles.js` (`mountPartner`) |
| GET | `/tokens[?mine=1\|?all=1]` | partner; `?all=1` adminish | `roles.js`, `admin.js` |
| POST | `/captcha/verify` | adminish | `admin.js` |
| GET | `/people` | adminish | `admin.js` (People card) |
| POST | `/people` | superadmin | `admin.js` create control → 201 with the key once |
| POST | `/people/revoke` | adminish | drop the person, key, sessions and sockets now |
| POST | `/people/rotate` | adminish | new key returned once; old key and sessions dead |
| POST | `/features` | admin | default flags for every chat request; a suffix overrides per call |
| POST | `/admin/session/clear` | adminish | `admin.js` drop button; closes every partner socket |
| GET | `/v1/models` | open | external OpenAI-shaped clients |
| POST | `/v1/chat/completions` | open | external clients (501 without `GLM_UPSTREAM`; forwards, signs and spends a pool entry with it) |
| GET | `/…` (static) | session for `.html`; assets + `login.html` public | every page |

Outbound calls: `CONFIG.captcha.verifyUrl` (Aliyun verify), and the chat forward
target — `GLM_UPSTREAM` when set, otherwise the source's captured origin — with
the path always taken from the source so `cn/` keeps `/api/v1`.
`GLM_IP_LOOKUP_URL` is *not* called by the hub; the browser does that.

Files: `hub.mjs` (all of the above), `ws.mjs` (`acceptKey`, `encodeFrame`,
`decodeFrames`, `attachSocket`, `OP`, `newId`). Proving suites: `check-chat.mjs`
(local upstream stub, 27 assertions) for forwarding and the pool, and
`check-people.mjs` (56 assertions, four hub restarts) for the directory.
