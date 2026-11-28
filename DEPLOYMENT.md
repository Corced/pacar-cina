# Deploy the frontend and backend

This is the host setup guide: frontend, backend, TLS, persistent state and verification. [`DEPLOYMENT_QUICKSTART.md`](DEPLOYMENT_QUICKSTART.md) is the credential guide. [`docs/FREE_TIER_RESEARCH.md`](docs/FREE_TIER_RESEARCH.md) holds the dated source facts.

## What gets deployed

`server/hub.mjs` serves `public/` on the same origin as `/minter/ws`. One port serves the pages, session routes, operator panel, mint socket and chat API. `npm run build` copies `public/` into `dist/` for a static copy, but the hub does not read `dist/`.

The process keeps sessions, partner sockets, jobs, chat history and contributed upstream tokens in memory. With `GLM_STATE_FILE`, it also writes the people directory and unexpired minted captcha params to one JSON file. This sets three rules:

- Run one hub process. Do not use two replicas, sticky sessions, serverless functions or overlapping rolling deploys.
- Give the process a persistent path if `GLM_STATE_FILE` is set.
- Put TLS in front when anyone signs in from another machine. Keys go in the `/session` request body and the session cookie needs a secure origin.

The hub speaks plain HTTP. TLS, WebSocket upgrades and the `X-Forwarded-*` headers come from the reverse proxy.

## Before you deploy

Before creating the host, get an upstream origin and key for real chat. Use `https://chat.z.ai` with a z.ai key, or `https://chatglm.cn` with a bigmodel.cn key. Without `GLM_UPSTREAM`, `/v1/chat/completions` returns 501. The minter still works.

You also need:

- A real Aliyun Captcha 2.0 scene and prefix. The captured defaults time out on real mints.
- A hostname you control for TLS. A bare IP works for a private HTTP test, but it sends keys in cleartext.

The credential steps are in [`DEPLOYMENT_QUICKSTART.md`](DEPLOYMENT_QUICKSTART.md). Generate three secrets locally:

```bash
node -p "require('node:crypto').randomBytes(32).toString('hex')"   # partner
node -p "require('node:crypto').randomBytes(32).toString('hex')"   # admin
node -p "require('node:crypto').randomBytes(32).toString('hex')"   # SESSION_SECRET
```

## Run it locally first

From the `app/` directory:

```bash
cp .env.example .env
# edit .env and uncomment the values you need
npm run hub:env
```

`npm run hub` does not load `.env`. `npm run hub:env` runs `node --env-file=.env server/hub.mjs` and needs Node 20.6 or newer. Node 22 is the safe choice because the checks use current built-ins. There are no runtime dependencies and no `npm install` step.

Open `http://127.0.0.1:5082/`. A signed-out browser redirects to `login.html`. Sign in as partner, open the minter from the nav, then sign in as admin in another browser profile and open `/status`.

## Option A: Oracle Cloud Always Free VM

This is the recommended free host here. It gives you one always-on ARM machine, a persistent disk and unrestricted outbound traffic. Check Oracle's [Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) page before provisioning; limits and availability change. As of 2026-11-28 it lists 2 OCPUs and 12 GB of ARM Ampere A1 capacity, 200 GB of block volume and 10 TB/month outbound data. Older guides quote 4 OCPUs and 24 GB. The console wins.

Caveats from the same page:

- Ampere A1 instances must be in the tenancy's home region.
- Oracle may reclaim idle Always Free VMs. Idle means 95th-percentile CPU below 20 percent, network below 20 percent and memory below 20 percent for seven days.
- "Out of host capacity" is common. Try another availability domain or retry later.

### Create the machine

In the OCI console, create a compute instance:

- Shape: `VM.Standard.A1.Flex`, 1 OCPU and 6 GB RAM is enough.
- Image: Ubuntu 22.04 or 24.04 LTS, marked Always Free Eligible.
- Networking: public subnet and public IPv4 address.
- SSH: upload your public key.

Open TCP 80 and 443 in the VCN security list. Restrict SSH to your own IP if possible. Egress is open by default. If `ufw` is active inside the VM:

```sh
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
```

Point your domain's A record at the public IP before requesting a certificate.

### Install Docker and get the code

```sh
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
sudo apt update && sudo apt install -y git
git clone <your-repo-url> ~/glm2api
cd ~/glm2api/app
```

Log out and back in after the Docker group change. The repo's Dockerfile uses `node:22-alpine`, which has an ARM build.

If the repository is private, use a deploy key or token. Keep credentials out of the working tree.

### Write the environment file

Put the env file outside the repository:

```sh
sudo mkdir -p /opt/glm-data
sudo tee /opt/glm2api.env >/dev/null <<'EOF'
PORT=5082
HOST=0.0.0.0
NODE_ENV=production
GLM_KEYS=partner:REPLACE_PARTNER_KEY,admin:REPLACE_ADMIN_KEY
SESSION_SECRET=REPLACE_SESSION_SECRET
GLM_STATE_FILE=/data/state.json
GLM_PUBLIC_URL=https://glm.example.com
GLM_TRUST_PROXY=1
GLM_UPSTREAM=https://chat.z.ai
GLM_UPSTREAM_KEY=REPLACE_UPSTREAM_KEY
GLM_CAPTCHA_SCENE=YOUR_SCENE_ID
GLM_CAPTCHA_PREFIX=YOUR_PREFIX
GLM_CAPTCHA_REGION=sgp
EOF
sudo chmod 600 /opt/glm2api.env
```

Replace every placeholder. `GLM_PUBLIC_URL` is the outside address with `https://` and no trailing path. `GLM_TRUST_PROXY=1` makes the hub believe Caddy's `X-Forwarded-*` headers so per-caller limits use the visitor address instead of the proxy's loopback address. Never set that combination on a hub exposed directly to the internet.

For chatglm.cn, set `GLM_UPSTREAM=https://chatglm.cn` and use a `cn/…` model id in checks.

### Build and run the container

```sh
docker build -t glm2api .
docker run -d --name glm2api --restart unless-stopped \
  --env-file /opt/glm2api.env \
  -v glmdata:/data \
  -p 127.0.0.1:5082:5082 \
  glm2api
docker logs -f glm2api
```

The host binding keeps the hub off the public interface. Caddy is the only public listener. Check locally:

```sh
curl http://127.0.0.1:5082/v1/models
curl -I http://127.0.0.1:5082/
```

`/v1/models` is open and returns the model catalog. `/` redirects to `/login.html`.

### Put Caddy in front

```sh
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
glm.example.com {
    reverse_proxy 127.0.0.1:5082
}
EOF
sudo systemctl restart caddy
sudo systemctl enable caddy
```

Caddy gets a certificate and passes WebSocket upgrades through the same `reverse_proxy` directive. Check from your own machine:

```sh
curl -I https://glm.example.com/
curl https://glm.example.com/v1/models
node check-serve.mjs https://glm.example.com
```

`check-serve.mjs` checks that the pages and assets are served. Run it from a local checkout of the repo.

### Update

```sh
cd ~/glm2api/app
git pull
docker build -t glm2api .
docker rm -f glm2api
docker run -d --name glm2api --restart unless-stopped \
  --env-file /opt/glm2api.env \
  -v glmdata:/data \
  -p 127.0.0.1:5082:5082 \
  glm2api
docker logs -f glm2api
```

Stop the old container before starting the new one. Two containers would split sessions and sockets and both would write the same state file.

## Option B: Node under systemd, without Docker

Install Node 22 for Linux ARM64 from [nodejs.org](https://nodejs.org/). The repo has no runtime dependencies. Create a `glm` service user, put the env file at `/opt/glm2api.env`, then:

```sh
sudo tee /etc/systemd/system/glm2api.service >/dev/null <<'EOF'
[Unit]
Description=glm2api hub
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=glm
WorkingDirectory=/home/glm/glm2api/app
EnvironmentFile=/opt/glm2api.env
ExecStart=/usr/local/bin/node server/hub.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now glm2api
sudo journalctl -u glm2api -f
```

Use the real path to your Node binary and a directory the `glm` user can read. Keep `GLM_STATE_FILE` on a persistent path and keep `HOST=0.0.0.0` in the env file when Caddy proxies to loopback.

## Option C: Render or Koyeb free tier, for demos only

Both platforms can run the Node process and accept WebSocket connections. Neither is a good home for this project's state.

- [Render free web services](https://render.com/docs/free) spin down after 15 minutes without HTTP requests or WebSocket messages. They lose local files on redeploy or spin-down and cannot attach a persistent disk. Render may restart them at any time, and may suspend a free service that sends an uncommonly high volume of outbound traffic. This project calls Aliyun and an upstream on every mint or chat turn. A connected minter's 25-second pings count as traffic, but no tab is guaranteed.
- [Koyeb free instances](https://www.koyeb.com/docs/reference/instances) give 0.1 vCPU, 512 MB and 2 GB SSD, one per organization. They scale down to zero after one hour without traffic and cannot use volumes. Signup requires card verification.

Use these for a demo or a proof of the mint flow. Every restart or spin-down loses sessions and unexpired minted params. If that is acceptable:

1. Deploy from the repository as a Web Service. Use the Dockerfile or `npm start`. The platform injects `PORT`; the hub reads it.
2. Set `HOST=0.0.0.0` and `NODE_ENV=production`.
3. Set `GLM_PUBLIC_URL` to the platform URL, for example `https://glm2api.onrender.com`, and `GLM_TRUST_PROXY=1`.
4. Set role keys, `SESSION_SECRET`, the upstream key and the captcha values in the platform's secret store.
5. Point the health check at `GET /v1/models`. That route is open. There is no `/healthz`.
6. Leave `GLM_STATE_FILE` unset. A state file on the container filesystem disappears on the next restart.

The platform's HTTPS terminator supplies `wss://` and the forwarded headers. Do not open another port.

## Option D: home machine with a tunnel

Run `npm run hub:env` on a machine you control. Set `HOST=127.0.0.1` and keep `GLM_STATE_FILE` on your own disk. Expose it through a tunnel that supports HTTPS and WebSocket forwarding. Cloudflare Tunnel is one free option; check its current docs because CLI names and dashboard steps change.

This avoids inbound router ports and keeps state on your disk. Still run one tunnel to one hub.

## Check the deployment

From your own machine:

```sh
node check-serve.mjs https://glm.example.com
node check-docs.mjs
npm run check
```

Then in a browser:

1. Open `https://glm.example.com/`. You should land on `login.html`.
2. Sign in with the partner key. You land on `partner.html`.
3. Open the minter from the nav. It should show LIVE and a non-empty egress IP.
4. Sign in as admin in a second browser profile. `/status` should show one partner online and a pool target of 750.
5. Open the chat page and send a message. With a working upstream you get a completion. Without one you get the deliberate 501.

For the real upstream check, set `GLM_UPSTREAM` and `GLM_UPSTREAM_KEY` in your shell and run `node doctor.mjs live` or `node doctor.mjs live cn/glm-5.3`. The doctor starts its own local hub, so it does not touch the deployment's state or sessions.

## Operational rules

- One replica. No load balancer across hubs, no serverless, no overlapping rolling deploy.
- Keep `GLM_STATE_FILE` on a persistent volume and back it up. It contains names, salts, scrypt hashes and single-use captcha params, not role keys.
- Pin `GLM_KEYS` and `SESSION_SECRET`. Generated role keys last one process lifetime, and a state file does not rescue partner or admin role keys.
- Serve TLS. Keys cross the network in the `/session` request body.
- Set `GLM_TRUST_PROXY=1` only behind a proxy you control.
- `GLM_EGRESS_ROUTES` takes bare `host:port` values, for example `127.0.0.1:9050`. It routes chat forwards and upstream-key probes. Captcha calls stay direct.
- The browser IP lookup uses `GLM_IP_LOOKUP_URL`, default `api.ipify.org`. Override it if that service is unreachable.

## Host sources

- Oracle: <https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm>
- Render: <https://render.com/docs/free>
- Koyeb: <https://www.koyeb.com/docs/reference/instances>
- Node: <https://nodejs.org/>

Host limits change. Check each console before planning around a number in this page.
