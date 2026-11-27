# Start here

A working copy of one small protocol: the captcha-minter page the upstream chat
sites use, plus the relay that turns a minted captcha parameter into an
OpenAI-shaped `/v1/chat/completions` call.

New to the documentation? Read this page for the shape, `HANDOFF.md` for proof
and open gaps, `README.md` for every route and setting, and
`DEPLOYMENT_QUICKSTART.md` for credentials and free-tier sources.

It is a clean-room rebuild (no code from the reference projects) and it is
deliberately dependency-free: no `npm install`, no bundler, no build step between
the file you read and the file the browser runs. Plain HTML, CSS and ES5-ish
`var`/`function` JavaScript, typed with JSDoc comments instead of TypeScript.

Read this page once. Then keep `HANDOFF.md` open beside it: that is the evidence
ledger, every claim paired with the check that fails if the claim stops being
true. This page is the orientation; that one is the proof.

## The shape of it

```
partner browser              hub (server/hub.mjs)                upstream
───────────────              ────────────────────                ────────
index.html                   pool: minted captcha params         chat.z.ai
  │  mints a captcha           │                                  chatglm.cn
  └────── /minter/ws ──────────┤
                               └── a chat call spends one and ──────►
                                   refunds it on 401/403/429
```

One Node process, no database, no framework. It serves the pages, holds the
WebSocket the minter connects to, keeps the token pool, signs the upstream
request and forwards it. The pages are split by role: `login.html` is the front
door (one key field - the key names its own role), `index.html` the minter,
`chat.html` the API's face, `partner.html`, `user.html` and `admin.html` the three
dashboards, `repos.html` the comparison with the reference projects.

## Four ideas that explain most of the code

**1. The pool is single-use captcha params, not credentials.** A partner's
browser mints a captcha answer, hands it to the hub over the socket, and the hub
keeps it for half an hour. A chat call attaches one as `captcha_verify_param`,
then either spends it or returns it: a `401/403/429` upstream refunds the entry.
The same param must be replayed verbatim, so it cannot be hashed — it is the one
thing written to the state file in the clear, and only while it lives.

**2. Identity is key → role → person.** A key maps to a role, or to a person who
holds a role. Keys are stored as `scrypt` hashes with a per-person salt, so the
state file is a list of names, not credentials. Revocation is immediate: the
person's key stops working on the next request and their live sessions and mint
sockets are dropped with it. The nav bar hides links it knows you cannot use,
but hiding is not the lock — every route re-checks the session. If you take one
thing from the code, take this: authorisation lives on the server, always.

**3. Honest degrade.** When it cannot do a thing, it says so instead of
pretending: `501` with a reason when no upstream is configured, `unverified`
rather than `valid` when Aliyun could not confirm a donation, a dash rather than
yesterday's figure when a poll fails, `x-glm-pool: empty` when a call had to go
out with no param, `x-glm-key: pool|pool-unverified|env|none` naming which
credential answered, `x-glm-egress: proxy|tor|direct|direct-fallback` saying
whether a call was routed. Several checks exist only to keep that rule from
quietly eroding.

**4. One process, on purpose.** Sessions, partner sockets, jobs, the pool, the
chat ledger and contributed upstream tokens all live in that process's memory.
Only the people directory and the unexpired pool survive a restart, and only with
`GLM_STATE_FILE` set. That is a design choice with deployment consequences: one
replica, one volume, no serverless, and every restart signs everyone out. Scale
by giving the one process more room, not by starting a second — two hubs sharing
a state file silently lose each other's people.

## What is proven

`npm run check` — nine suites plus the doctor's self-test, all exit 0. Five are
behavioural and carry **350 assertions** (73 hub, 113 config, 9 multi-partner,
98 chat, 57 people); the rest check structure and documentation.

The ones worth knowing about:

- three partners connected at once get an exactly even split of work;
- a minted param is spent by a chat call and refunded when upstream refuses it;
- revocation is immediate, including live sockets, and survives a restart;
- the pool and the people directory come back after a restart;
- a chat call can go through a SOCKS5 route, is labelled on the reply, and falls
  back labelled when the route is dead;
- a contributed upstream token is gated (shape → JWT claims → one signed probe)
  and never written to disk, logged, or returned by any route.

"Proven" means an assertion fails if the behaviour stops being true. It does not
mean the real upstream has ever answered. That distinction is the whole point of
the next section.

## What is not proven — and what needs a person, not a commit

Everything below is blocked on something this repository cannot contain: an
account credential, an account-bound widget configuration, or a human's time and
eye. No amount of code closes these, which is why they are listed separately from
ordinary work.

| Gap | What it needs | What a pass looks like |
| --- | --- | --- |
| 1 | A real `chat.z.ai` bearer token — contributed through the browser at any signed-in role, or set as `GLM_UPSTREAM_KEY` | `200` with a completion, `x-glm-key: pool` or `env`, recorded with the date and the command |
| 2 | A real Aliyun appkey **and** scene id, in a browser; the current ones end every mint at `captcha mint timeout`. If the challenge widget fires, one human gesture | a minted param appears in the pool and `/status` counts it; the param is then accepted by `POST /captcha/verify` |
| 3 | The same credential as 1, once per suffix — plus **your judgement** on whether the feature visibly fired (a thinking block, cited results, a research plan) rather than a flag riding along | three recorded bodies, one per suffix, each labelled fired or ignored |
| 4 | Half an hour of a real, unminimised tab, and a side-by-side 390 px screenshot against the reference page | `minter.served` climbing with no reconnect lines; a named diff image and the differing elements |
| 5 | A `chatglm.cn` account token specifically — a z.ai token does not substitute | `200` from a `cn/…` model id, plus the three suffix calls again for that source |

The mechanical half of gaps 1, 3 and 5 is one command: `node doctor.mjs live`
starts its own hub, makes one real call and prints `PROVEN` or the exact status
and body that refused it. It needs `GLM_UPSTREAM` and `GLM_UPSTREAM_KEY` in the
environment — it starts a hub of its own, so a token contributed through a
browser into some other hub is not visible to it — and without them it says so
rather than guessing. `node doctor.mjs` on its own reports what this machine
already has and what each gap still needs.

**Not every gap is like this.** Two gaps closed on 2026-11-22 without a person
involved — the pool surviving a restart, and egress going through SOCKS5 — because
a local stub could make the assertion fail in exactly the same way the real thing
would. That is the test to apply before calling something "blocked": could a stub
prove it? If yes, it is ordinary work. If no, it belongs in the table above.

## Closing one of them

1. Run the gap's runbook in `HANDOFF.md`. Every step is something one person with
   a browser and a terminal can do in an afternoon; none needs a design change.
2. Record the date, the exact command, and the observed output under that gap — a
   pasted answer beats a description. A failure is worth recording too:
   `` `401 USER_BLOCKED` on 2026-11-22 `` tells the next person more than silence.
3. Move the record to "What has been closed", delete the gap, and lower the
   numbered-gap floor in `check-docs.mjs` **in the same edit** (and the same
   number in `doctor.mjs`'s self-test). That floor is a tripwire against a gap
   vanishing by accident, not a rule against closing one.

## Running it

```bash
node server/hub.mjs                    # http://127.0.0.1:5082, keys generated + printed once
npm run hub:env                        # same, reading .env (needs Node 20.6+ for --env-file)
npm run check                          # nine suites plus the doctor's self-test
node doctor.mjs                        # what each open gap needs, and what this machine has
```

Pin `GLM_KEYS=partner:…,admin:…` or the hub generates fresh keys every start and
prints them once. Deploying is one always-on process with a volume — no `npm run
build` (the hub serves `public/` directly), one replica, `NODE_ENV=production`
(or `HOST=0.0.0.0`), `GLM_STATE_FILE` on the volume, and `GLM_TRUST_PROXY=1` +
`GLM_PUBLIC_URL=https://…` behind the platform's TLS. A `Dockerfile` is in the
repo. See README "Deploying it" for the env block and the reasons.

## Where the truth lives

| File | What it is |
| --- | --- |
| `README.md` | the user manual: routes, every setting, the role table, deployment |
| `HANDOFF.md` | the evidence ledger: what works, what was closed and how, the five open gaps with runbooks, traps and conventions |
| `codemap.md`, `server/codemap.md`, `public/codemap.md` | architecture, data flow, and where each behaviour is implemented |
| `check-*.mjs` | the proof. Each failure names the behaviour it protects |
| `doctor.mjs` | the gap list, read from `HANDOFF.md` so it cannot list a gap twice |
| `INSTRUCTION.md` | how to work on this repo without breaking its rules |