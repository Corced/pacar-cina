# glm2api · captcha minter

A small, dependency-free Node service that runs a browser-backed Aliyun captcha minter and an OpenAI-shaped chat relay. The hub serves the pages, API, role gates, WebSocket mint socket and chat endpoints from one process on one port. There is no separate frontend deployment.

Written and maintained by **Corced**.

## Start here

| Goal | Read |
|---|---|
| New to the project? Get the shape, ideas and open gaps | [START-HERE.md](docs/start/START-HERE.md) |
| Run it locally and understand what to watch for | [INSTRUCTION.md](docs/guides/INSTRUCTION.md) |
| Host frontend and backend together | [DEPLOYMENT.md](docs/guides/DEPLOYMENT.md) |
| Get free-tier keys, captcha scene and gap checks | [DEPLOYMENT_QUICKSTART.md](docs/guides/DEPLOYMENT_QUICKSTART.md) |
| Every route, setting, model id and protocol detail | [Reference manual](docs/reference/README_REFERENCE.md) |
| Evidence ledger and historical handoff notes | [HANDOFF.md](docs/archive/HANDOFF.md) |
| Architecture and code maps | [Codemap](docs/reference/codemap.md), [server](docs/reference/server/codemap.md), [public](docs/reference/public/codemap.md) |
| Dated third-party free-tier facts | [FREE_TIER_RESEARCH.md](docs/research/FREE_TIER_RESEARCH.md) |

## Common commands

```bash
npm run build        # optional static copy of public/ into dist/
npm run hub          # start on http://127.0.0.1:5082, .env ignored
npm run hub:env      # start with .env loaded, Node 20.6+
npm run check        # all structural, type and behavioural checks
node doctor.mjs      # report open gaps and what closes them
```

## Deploy shape

One always-on process, one replica, one persistent volume when `GLM_STATE_FILE` is used. Put TLS and forwarded headers in front with a trusted reverse proxy. The hub serves `public/` directly; `dist/` is only a static copy. Read [DEPLOYMENT.md](docs/guides/DEPLOYMENT.md) before putting it online.

## Repository layout

```text
app/
├── public/              browser pages, scripts and styles
├── server/              hub, WebSocket and SOCKS5 implementations
├── docs/                all project documentation
│   ├── start/           newcomer orientation
│   ├── guides/          operator, hosting and credential guides
│   ├── reference/       reference manual and code maps
│   ├── research/        dated external service facts
│   └── archive/         historical evidence ledger
├── check-*.mjs          proof suites
├── doctor.mjs           gap report and live upstream probe
└── package.json         zero-dependency scripts
```

No runtime dependencies. No build step between source and browser. No separate frontend process.
