# How to run this — and what to watch for

A one-page operator guide. The depth lives elsewhere: [`README.md`](README.md)
for the routes, every setting and the design; [`HANDOFF.md`](HANDOFF.md) for the
honest status and the runbooks that close each open gap.

## What you are running

One Node process (`server/hub.mjs`) that serves the pages, keeps a pool of
captcha parameters that partner browsers mint, and forwards `/v1/chat/…` to an
upstream when you configure one. No database, no build step beyond a file copy,
no dependencies.

## Requirements

- **Node 22 or newer.** The checks use the built-in `WebSocket`, `fetch` and
  `headers.getSetCookie()`; older versions will fail in the check suite even
  though the hub itself may start.
- **A browser.** Everything the project actually does, it does with a real
  browser tab holding a WebSocket open.
- **Nothing to install.** The `package-lock.json` is a formality: there are no
  dependencies, and adding one breaks the project's premise.

## First run

```powershell
npm run build        # copies public/ into dist/ — the static copy
npm run hub          # starts the backend on http://127.0.0.1:5082
```

`npm run hub` prints the keys it generated for this run:

```
  superadmin key (printed once): glm-superadmin-…
  partner key (generated this run): glm-partner-…
  admin key (generated this run): glm-admin-…
  set GLM_KEYS=partner:<key>,admin:<key> to keep a key across restarts
```

Copy them somewhere before you close the window — they are printed once and a
restart generates new ones. Then, in a browser:

1. Open `http://127.0.0.1:5082/`. Signed out, it redirects to `login.html`;
   signed in, it goes straight to your role's page. **`/` is not the minter.**
2. Sign in as **partner** with the partner key → you land on `partner.html`.
3. Click **minter** in the nav bar → `index.html` connects, shows **LIVE**, and
   begins receiving mint jobs.
4. Sign in as **admin** with the admin key → `admin.html` shows partners,
   their egress IPs, the pool, the captcha counters and the feature toggles.
5. Optionally, `superadmin` (key from `GLM_SUPERADMIN`, else generated and
   printed once) creates and revokes people from the People card. With
   `GLM_STATE_FILE` set, that account and its key survive a restart too — the
   file keeps only a hash, so the printed key is still the one to keep.

One role per browser: the session cookie holds a single role. Use a second
profile or a private window for the admin view.

## Running the checks

```powershell
npm run check        # the whole chain, in order
```

Every suite that needs a hub starts its **own** on its own port and kills it
afterwards: `5199` (hub), `5201` (multi-partner), `5203` (chat), `5205` (people),
`5211` and `5212` (config). They are independent of your running hub — never
point them at it.

- A pass ends with `… check: …` per suite and exit code 0.
- A failure prints `FAIL <what>  — <detail>`, and because the chain is joined with
  `&&` the run stops at the first failing suite. **Read the detail column
  first**; it usually carries the measured value (`online=1`, `HTTP 403`,
  `held=200`) that makes the problem obvious.
- `EADDRINUSE` on one of those ports means a previous crashed run left a hub
  behind. Find and stop it before blaming the code:
  ```powershell
  Get-NetTCPConnection -LocalPort 5199,5201,5203,5205,5211,5212 -State Listen |
    Select-Object LocalPort, OwningProcess
  Stop-Process -Id <the pid>
  ```
- Run it before and after any change. It is the only thing standing between a
  plausible-looking edit and a silent regression.

## Running it for real

Defaults are a local demo. For anything longer-lived, set these:

```powershell
$env:PORT='5082'
$env:GLM_KEYS='partner:<secret>,admin:<secret>'   # keys survive a restart
$env:GLM_SUPERADMIN='<secret>'                    # same, for the top account (optional once a state file exists)
$env:SESSION_SECRET='<random>'                    # unset = every restart logs everyone out
$env:GLM_STATE_FILE='C:\private\glm-people.json'  # people + the seeded superadmin survive a restart
$env:GLM_PUBLIC_URL='https://glm.example.com'     # if a proxy/tunnel hides the real name
$env:HOST='0.0.0.0'                               # only if something in front proxies to it
node server/hub.mjs
```

Add chat forwarding only when you have a credential:

```powershell
$env:GLM_UPSTREAM='https://chat.z.ai'   # an ORIGIN; the model id picks the path
$env:GLM_UPSTREAM_KEY='<bearer token>'
```

Without `GLM_UPSTREAM`, `/v1/chat/completions` answers `501` with the reason.
That is the design, not a misconfiguration.

## What to pay attention to

**The seven that actually bite:**

1. **`/` is not the minter.** `/` redirects — to `login.html` when signed out, to
   your role's page when signed in. The minter is `index.html`. `minter.html`
   does not exist.
2. **A page without a hub is a demo.** `dist/` is a plain static copy: pages
   render, but every button is inert and `index.html` runs a **labelled demo**
   instead of the real widget. Never cite that demo as a successful mint.
3. **Generated keys and sessions are per-process.** Without `GLM_KEYS` /
   `GLM_SUPERADMIN` / `SESSION_SECRET`, every restart voids the role keys and
   every sign-in. `GLM_STATE_FILE` rescues the people directory and the seeded
   superadmin only — partner and admin role keys still need `GLM_KEYS`. Write
   them down or pin them.
4. **`GLM_WS_AUTH=open` and `GLM_TRUST_PROXY=1` are dangerous on the open
   internet.** The first lets anonymous sockets receive mint work; the second
   lets a visitor forge the address the panel prints. Both are escape hatches
   for a trusted network only, and the hub logs a warning for the first.
5. **Hiding a link is not access control.** The nav bar is written per role as a
   convenience; every JSON route checks its own role server-side. Do not "fix"
   access by removing a link.
6. **The honest-degrade rule.** Where the project cannot do something it says so:
   `501` with a reason, `unverified` instead of `valid`, a demo labelled as a
   demo. Turning any of those into an optimistic success is the one change that
   makes the whole repo untrustworthy — the checks are written to catch it.
7. **Nothing outside the people directory survives a restart.** The pool holds
   captcha params that expire in 30 minutes, so it is deliberately in memory: a
   restart empties it and partners refill it. Sessions dying is a feature.

**Then, in rougher order of surprise:**

8. **The Aliyun appkey is public by design** (`FFFF0N00000000007EC0`). The
   widget ships it to every browser. Do not "protect" it; nothing is leaked.
9. **Keys pinned in the environment win.** A person or superadmin defined by
   `GLM_PEOPLE` / `GLM_SUPERADMIN` cannot be revoked or rotated through the
   API — that refusal is intentional, otherwise a stale state file could
   resurrect a key someone deliberately removed. Remove it from the env and
   restart instead.
10. **`GLM_STATE_FILE` holds hashes, not keys.** Names, roles, a salt and a
    `scrypt` hash per person — the seeded superadmin included. Losing it logs
    nobody out but costs you the superadmin key (set `GLM_SUPERADMIN` to
    recover); sharing it leaks a guessable list, not working credentials. It is
    still written `0600` (a POSIX mode — on Windows that flag is advisory, so the
    folder is the real control) and must stay out of the repo.
11. **Hashing protects the store, not the wire.** A key is still posted to
    `/session` in the request body. On loopback that is fine; from another
    machine it needs TLS in front of the hub, or the key is readable in transit.
12. **The default bind is loopback** (`HOST=127.0.0.1`). To serve another
    machine, set `HOST=0.0.0.0` *and* put a real proxy in front of it — this hub
    speaks plain HTTP, and the only limiting it does is the per-caller chat cap
    (`GLM_CHAT_CONCURRENCY`, 4 at once). There is no global rate limit, no
    connection cap and no TLS; the proxy supplies those.
13. **Check before you trust a doc edit.** `check-docs.mjs` parses `HANDOFF.md`
    and `README.md`: every setting name must exist in `server/hub.mjs`, every
    `public/` or `server/` path must exist on disk, and the numbered-gap list
    has a floor so a gap cannot vanish by accident. If you closed a gap, delete
    it *and* lower the floor in the same edit.
14. **Suffixes are additive and declarative.** `-think`, `-search`,
    `-deepresearch` rewrite the model id and set flags; the panel's toggles are
    defaults for every request, OR'd with the suffix. A suffix turns a feature
    on, never off. What the live upstream *does* with them is still unproven —
    see `HANDOFF.md` gap 3.
15. **Pool size is `TOKEN_TARGET` / `TOKEN_LOWWATER`, not `GLM_*`.** Easy to
    typo, and a typo silently does nothing because unset means the recorded
    default.
16. **PowerShell specifics.** Setting a variable is `$env:NAME='value'` (not
    `export`), `curl` is an alias for `Invoke-WebRequest` so write `curl.exe`
    for the real one, and a long-running `node server/hub.mjs` occupies the
    terminal — use a second one, or start it in the background.

## Where to go next

| You want | Read |
|---|---|
| Every route, setting and model id | [`README.md`](README.md) |
| What is proven, what is not, and the runbook to close each gap | [`HANDOFF.md`](HANDOFF.md) |
| How the code is organised | [`codemap.md`](codemap.md) |
| The mint loop and the hub's internals | [`server/codemap.md`](server/codemap.md) |
| Page → script → route wiring | [`public/codemap.md`](public/codemap.md) |