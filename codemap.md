# glm2api · captcha minter — codemap

Master entry point. Read this first, then the sub-map for the folder you touch.

## What this repository is

A rebuild of one page — a browser tab a volunteer leaves open so it can mint
Aliyun captcha parameters for a shared pool — plus the backend that page needs to
be useful: a **hub** that spreads the mint work across every connected browser,
authenticates the roles that may contribute, and verifies donations against
Aliyun instead of trusting them.

It is a **consent surface**: anyone connecting lends a browser tab and a network
address. The pages say so, and nothing claims more than it does.

Zero runtime dependencies is a hard constraint. No `npm install` may become
necessary; `server/ws.mjs` exists because a WebSocket library would have broken
it. Everything lives under `app/`.

## Status in one paragraph

The mint pipeline works end to end and is proven by the check suite: a
key-gated socket, real job round-trips, an even spread across partners, a pool
that stops at its target and refills itself — and a pool that is actually
**spent**: the chat path attaches the oldest minted param to the upstream request
as `captcha_verify_param`, signs the request, and returns the entry on a
credential rejection. Identity is revocable at runtime: a superadmin creates
people, an admin revokes or rotates, and the person's key, live sessions and open
sockets all stop at once — with the directory kept in `GLM_STATE_FILE` so a
revocation survives a restart. Not done, and stated as such in the UI and in
`HANDOFF.md`: no call to the real chat.z.ai / chatglm.cn has succeeded (the path
is proven against a local stub), a real widget mint has never been captured,
egress routing is a toggle, and everything except the people directory and the
minted-token pool is still in memory on purpose (minted params are single-use
Aliyun answers, so they may sit in `GLM_STATE_FILE` until they expire; sessions,
jobs, donations and the chat ledger never do). `HANDOFF.md` is the authoritative honest-status document;
`README.md` is the reference (every route, every setting, the protocol in full).

## Root assets

| File | Role |
|---|---|
| `README.md` | the reference manual — routes, env vars with defaults, mint protocol, model ids, what is deliberately not done |
| `HANDOFF.md` | orientation note: what works, what does not, and the traps that have already bitten someone |
| `INSTRUCTION.md` | one-page operator guide: first run, the pages, the checks, and what to watch for |
| `package.json` | zero-dependency manifest + scripts: `start`, `build`, `hub`, `check` |
| `START-HERE.md` | the orientation page: the shape of the system, the four ideas behind the code, what is proven, and which gaps need a person rather than a commit |
| `build.mjs` | copies `public/` → `dist/`; **fails** if any server code would land in `dist/` or a required page is missing |
| `server/hub.mjs` | the whole backend (see `server/codemap.md`) |
| `server/ws.mjs` | hand-written RFC 6455 WebSocket server |
| `server/socks5.mjs` | hand-written SOCKS5 client: CONNECT over a route, `forward()` for the routed chat call |
| `Dockerfile` | one always-on image (`node:22-alpine`, `NODE_ENV=production`, a `/data` volume); `.dockerignore` keeps `node_modules`, `dist` and `.env` out of it |
| `public/` | the entire published site (see `public/codemap.md`) |
| `dist/` | build output — generated, never edit |
| `.repos/` | downloaded reference-project archives (research material, never published) |
| `check-*.mjs` | the suites `npm run check` runs |
| `doctor.mjs` | reads the gap list from `HANDOFF.md` and prints what closes each one; `live` makes one real upstream call and reports `PROVEN` or the exact refusal |
| `check-chat.mjs` | chat forwarding against a local upstream stub: signing, pool spend, refund, the per-caller 429 |
| `check-people.mjs` | the people directory: create, revoke (key + sessions + sockets), rotate, the state file, hashing at rest, the seeded superadmin across a restart |
| `fetch-repos.mjs` | downloads the three reference projects into `.repos/` |
| `.slim/codemap.json` | codemap change-detection state |

## Repository directory map

| Directory | Responsibility | Link |
|---|---|---|
| `server/` | HTTP + WebSocket backend: config, key→role→person identity, HMAC session cookies, mint job board, token pool life cycle, Aliyun verification, OpenAI-shaped chat forwarding, role-gated static serving with injected nav | [View Map](server/codemap.md) |
| `public/` | The published static site: seven pages, six IIFE scripts, four stylesheets, with a hub-or-demo dual mode and a `<!--nav-->` slot the hub fills | [View Map](public/codemap.md) |
| `dist/` | Build output, byte-identical copy of `public/`; served by the hub on the same origin as the socket | — (generated) |
| `.repos/` | Reference-project archives + `fetch-repos.mjs`; excluded from build and publish | — (research) |

## Data flow, at a glance

```
browser (partner)                      hub (server/hub.mjs)                 internet
 index.html + minter.js  ──WS /minter/ws──▶  job board, pool, sessions  ──▶  Aliyun verify
   └ needs GLM global                        role gates, nav injection      ──▶ z.ai / chatglm.cn
 login/user/partner/admin/chat  ──HTTP──▶  /session /status /status/self /tokens /config /v1/*
```

Three flows carry the system, each written out as an arrow trace in
`server/codemap.md`: **sign-in** (key → HMAC cookie → page gate), **mint**
(upgrade → hello → job → captcha → pool → sweep/refill), **chat**
(resolve model → continuation → source routing → forward, or 501/502).

## Where to start by task

| Task | Read |
|---|---|
| Change a route, gate, or pool rule | `server/hub.mjs` + `server/codemap.md`, then `npm run check` |
| Change a page's behaviour | `public/codemap.md` for the page→script→route table |
| Change the mint protocol | `server/hub.mjs` `onMinterSocket` **and** `public/minter.js` — the two must move together |
| Change the captcha widget config | `GET /config` in the hub *and* `glm-client.js loadConfig()` |
| Verify anything | `npm run check` (nine suites + the doctor's self-test, 347 counted assertions) - see `HANDOFF.md` "Verifying" |

## Traps (from `HANDOFF.md`, still true)

1. `/` is not the minter — it redirects to `login.html`, or to your role's page.
2. `minter.html` does not exist; the minter is `index.html`.
3. The nav bar is written by the hub into `<!--nav-->`, not by a script.
4. Hiding a link is not access control — every route enforces its own role.
5. Restarting the hub drops the pool, every session, and any generated key.
6. `GLM_TRUST_PROXY=1` in front of the open internet lets a visitor forge the
   address the panel prints.
7. The honest-degrade rule: where something cannot be done, refuse with the
   reason (501, `unverified`, a labelled demo). Several checks assert it.
8. Zero dependencies, files only under `app/`; `build.mjs` refuses a `dist/` leak.
9. The Aliyun appkey is public by design — shipping it to browsers is the widget.
