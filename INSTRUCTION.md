# How to run this - and what to watch for

A one-page operator guide. The depth lives elsewhere: [`README.md`](README.md) for routes and settings, [`HANDOFF.md`](HANDOFF.md) for honest status and gap runbooks. For credentials and free tiers, read [`DEPLOYMENT_QUICKSTART.md`](DEPLOYMENT_QUICKSTART.md); its sources are in [`docs/FREE_TIER_RESEARCH.md`](docs/FREE_TIER_RESEARCH.md).

## What you are running

One Node process (`server/hub.mjs`) that serves the pages, keeps a pool of captcha parameters that partner browsers mint, and forwards `/v1/chat/…` to an upstream when you configure one. No database, no build step beyond a file copy, no dependencies. External API keys may cost money after a trial or outside free models.

## Requirements

- **Node 22 or newer** for the checks: they use built-in `WebSocket`, `fetch` and `headers.getSetCookie()`. `package.json` allows Node 18+ for the hub itself; older versions may start the hub but fail the suite.
- **A browser.** The project does its real work with a browser tab holding a WebSocket open.
- **Nothing to install.** `package-lock.json` is a formality. Adding a runtime dependency breaks the project's premise.

## First run

```powershell
npm run build        # copies public/ into dist/ - the static copy
npm run hub          # starts the backend on http://127.0.0.1:5082
```

`npm run hub` prints the keys generated for this run:

```
  superadmin key (printed once): glm-superadmin-…
  partner key (generated this run): glm-partner-…
  admin key (generated this run): glm-admin-…
  set GLM_KEYS=partner:<key>,admin:<key> to keep a key across restarts
```

Copy them before closing the window; a restart generates new ones. Then, in a browser:

1. Open `http://127.0.0.1:5082/`. Signed out, it redirects to `login.html`; signed in, it goes to your role's page. `/` is not the minter.
2. Sign in as **partner** with the partner key. You land on `partner.html`.
3. Click **chat** in the nav bar. Pick a model and send a message. The next turn continues the same conversation because the page hands the hub's `x-glm-chat` id back. Without `GLM_UPSTREAM` the page answers **501 with the reason**.
4. Click **minter** in the nav bar. `index.html` connects, shows **LIVE** and begins receiving mint jobs. `user.html` reports what the hub can prove about your address; it does not solve anything itself.
5. Sign in as **admin** with the admin key. `admin.html` shows partners, their egress IPs, the pool, captcha counters and feature toggles.
6. Optionally, a **superadmin** creates and revokes people from the People card. Its key comes from `GLM_SUPERADMIN` or is generated and printed once. With `GLM_STATE_FILE` set, that account and its key survive a restart; the file keeps a hash, so keep the printed key.

One role per browser. The session cookie holds a single role. Use a second profile or private window for the admin view.

## Running the checks

```powershell
npm run check        # the whole chain, in order
```

Every suite that needs a hub starts its own on its own port and kills it afterwards: `5199` (hub), `5201` (multi-partner), `5203` (chat), `5205` (people), `5211` and `5212` (config). `5202` is the stand-in Aliyun verify endpoint; `5204` to `5209` are chat stubs and SOCKS5 stubs used by `check-chat.mjs`. They are independent of your running hub.

- A pass ends with `… check: …` per suite and exit code 0.
- A failure prints `FAIL <what>  - <detail>`. The chain uses `&&`, so it stops at the first failing suite. Read the detail column first; it usually carries the measured value.
- `EADDRINUSE` on one of those ports means a previous crashed run left a hub behind. Find and stop it before blaming the code:

  ```powershell
  Get-NetTCPConnection -LocalPort 5199,5201,5202,5203,5204,5205,5206,5207,5208,5209,5211,5212 -State Listen |
    Select-Object LocalPort, OwningProcess
  Stop-Process -Id <the pid>
  ```

- Run it before and after any change. It is the only thing standing between a plausible-looking edit and a silent regression.

## What is left, and how to close it

```powershell
node doctor.mjs                    # every open gap, what closes it, and what this machine has
node doctor.mjs live               # one real z.ai call after GLM_UPSTREAM + key are set
node doctor.mjs live cn/glm-5.3    # one real chatglm.cn call
```

`doctor.mjs` reads the gap list from `HANDOFF.md`, so it cannot list a closed gap. It never prints a key and never writes a file. `live` takes an optional model id, not environment assignments. Set those before the command. When it prints `PROVEN`, record the line under the gap in `HANDOFF.md` and delete the gap; the doctor only does the mechanical part.

## Running it for real

Defaults are a local demo. For anything longer-lived:

```powershell
$env:PORT='5082'
$env:GLM_KEYS='partner:<secret>,admin:<secret>'   # keys survive a restart
$env:GLM_SUPERADMIN='<secret>'                    # top account; optional once a state file exists
$env:SESSION_SECRET='<random>'                    # unset = every restart logs everyone out
$env:GLM_STATE_FILE='C:\private\glm-people.json'  # people + seeded superadmin survive a restart
$env:GLM_PUBLIC_URL='https://glm.example.com'     # if a proxy/tunnel hides the real name
$env:HOST='0.0.0.0'                               # only if something in front proxies to it
node server/hub.mjs
```

Add chat forwarding only when you have a credential:

```powershell
$env:GLM_UPSTREAM='https://chat.z.ai'   # an ORIGIN; the model id picks the path
$env:GLM_UPSTREAM_KEY='<bearer token>'
```

Without `GLM_UPSTREAM`, `/v1/chat/completions` answers `501` with the reason. That is the design, not a misconfiguration. For `cn/…` models, use `GLM_UPSTREAM=https://chatglm.cn` and a chatglm.cn key. Credential runbooks are in `DEPLOYMENT_QUICKSTART.md`.

## What to pay attention to

1. `/` is not the minter. It redirects to `login.html` when signed out and to your role's page when signed in. The minter is `index.html`. `minter.html` does not exist.
2. A page without a hub is a demo. `dist/` is a static copy: pages render, buttons are inert and `index.html` runs a labelled demo. Never cite that demo as a successful mint.
3. Generated keys and sessions are per-process. Without `GLM_KEYS`, `GLM_SUPERADMIN` and `SESSION_SECRET`, every restart voids role keys and sign-ins. `GLM_STATE_FILE` rescues the people directory and seeded superadmin only; partner and admin role keys still need `GLM_KEYS`.
4. `GLM_WS_AUTH=open` and `GLM_TRUST_PROXY=1` are dangerous on the open internet. The first lets anonymous sockets receive mint work; the second lets a visitor forge the address the panel prints. The hub warns about the first.
5. Hiding a link is not access control. The nav bar is written per role as a convenience; every JSON route checks its own role server-side.
6. Honest degrade is the rule. Where the project cannot do something it says so: 501 with a reason, `unverified` instead of `valid`, a demo labelled as a demo. Several checks fail if that erodes.
7. The pool holds captcha params that expire in 30 minutes, so it is in memory by default. With `GLM_STATE_FILE` set, unexpired minted params and the people directory survive a restart; sessions, jobs, donations and the chat ledger never do.

Then, in rougher order of surprise:

8. The Aliyun appkey is public by design (`FFFF0N00000000007EC0`). The widget ships it to every browser. Do not treat it as a leaked secret.
9. Keys pinned in the environment win. A person or superadmin defined by `GLM_PEOPLE` or `GLM_SUPERADMIN` cannot be revoked or rotated through the API. Remove the value from the environment and restart.
10. `GLM_STATE_FILE` holds names, roles, salts and scrypt hashes, never keys. Losing it costs you the seeded superadmin key unless `GLM_SUPERADMIN` is set. It is written `0600` on POSIX; on Windows the folder is the real control. Keep it out of the repo.
11. Hashing protects the store, not the wire. A key is posted to `/session` in the request body. From another machine it needs TLS in front of the hub.
12. The default bind is loopback (`HOST=127.0.0.1`). To serve another machine, set `HOST=0.0.0.0` and put a real proxy in front. The hub speaks plain HTTP. It limits chat to four in-flight requests per address and identity, and donations to four Aliyun exchanges per caller. The proxy supplies global rate limits, connection caps and TLS. Donating sessions buys no chat capacity.
13. `check-docs.mjs` parses `HANDOFF.md` and `README.md`: every setting name must exist in `server/hub.mjs`, every `public/` or `server/` path must exist, and the numbered-gap list has a floor. If you close a gap, delete it and lower the floor in the same edit.
14. Suffixes are additive and declarative. `-think`, `-search` and `-deepresearch` rewrite the model id and set flags; panel toggles are defaults OR'd with suffixes. What the live upstream does with them is still unproven, `HANDOFF.md` gap 3.
15. Pool size is `TOKEN_TARGET` and `TOKEN_LOWWATER`, not `GLM_*`. A typo silently does nothing because unset means the recorded default.
16. PowerShell uses `$env:NAME='value'`, not `export`; `curl` is an alias for `Invoke-WebRequest`, so use `curl.exe` for the real one; a long-running `node server/hub.mjs` occupies the terminal, so use a second one.
17. A model id is parsed from the right. `z.ai/glm-5.3-max-think` is base `glm-5.3-max` plus `-think` and forwards with `x-glm-model-known: false`. The base must start with `glm` unless pinned in `GLM_MODEL_EXTRA`. Hand back `x-glm-chat` as `chat_id` to continue a conversation; another caller's id answers the same 404 as a missing one; a second turn during a first gets 409. A restart turns the next continuation into 404 because conversations are memory-only.
18. Run one hub per `GLM_STATE_FILE` and chat ledger. The people file is saved whole, so a second process overwrites it with a stale directory; conversations live in memory, so a second hub answers 404 to the first one's chat ids.

## Where to go next

| You want | Read |
|---|---|
| Every route, setting and model id | [`README.md`](README.md) |
| What is proven and how to close each gap | [`HANDOFF.md`](HANDOFF.md) |
| Start here as a newcomer | [`START-HERE.md`](START-HERE.md) |
| Credentials and free tiers | [`DEPLOYMENT_QUICKSTART.md`](DEPLOYMENT_QUICKSTART.md) |
| How the code is organised | [`codemap.md`](codemap.md) |
| The mint loop and hub internals | [`server/codemap.md`](server/codemap.md) |
| Page, script and route wiring | [`public/codemap.md`](public/codemap.md) |
