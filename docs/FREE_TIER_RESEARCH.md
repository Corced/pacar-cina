# Free-Tier Research: GLM2API Deployment Dependencies

Researched 2026-11-26; reviewed against the implementation on 2026-11-27. External prices, quotas and console layouts change without notice. Verify them at the linked official sources before relying on them.

This file records third-party facts and how they meet this repo. It is not an operator runbook. For commands and environment values, read `DEPLOYMENT_QUICKSTART.md` and `README.md`.

Services covered:

1. [Aliyun Captcha 2.0](#1-aliyun-captcha-20)
2. [chat.z.ai OpenAI-compatible API](#2-chatzai-openai-compatible-api)
3. [chatglm.cn / Zhipu bigmodel.cn token](#3-chatglmcn--zhipu-bigmodelcn)
4. [Tor / SOCKS5 proxies for outbound routing](#4-tor--socks5-proxies)

---

## 1. Aliyun Captcha 2.0

**What it is:** Alibaba Cloud's managed CAPTCHA service (slider / intelligent captcha). The browser widget mints a serialized captcha param; the hub can send that param to Aliyun for verification.

**Official signup / console:** <https://www.alibabacloud.com/product/captcha> - activation page: <https://common-buy.alibabacloud.com/?commodityCode=waf_captchav2_public_intl>

**Free tier facts:**

- Billed **pay-as-you-go** by verification count; resource plans are pre-paid packs. There is **no permanent free quota**. Low volume costs a fraction of a cent per verification, but it is not free.
  - Billing overview: <https://www.alibabacloud.com/help/en/captcha/captcha2-0/billing-of-captcha-2-0>
  - Resource plans: <https://www.alibabacloud.com/help/en/captcha/captcha2-0/purchase-resource-plans>
- New accounts may receive **free trial resource packs** at <https://free.aliyun.com> (search "Captcha 2.0"). Terms vary by campaign.
- If payment is overdue by more than 7 days, Captcha 2.0 configs may be deleted with no recovery (billing page above).
- Existing resource plans remain valid when a new one is bought; the new plan starts after the old one expires.

**What this repo actually uses:**

| Env var | Looks like | Notes |
|---|---|---|
| `GLM_CAPTCHA_APPKEY` | `FFFF0N00000000007EC0` | Aliyun's public demo appkey, shipped to every browser by design. Source: <https://www.alibabacloud.com/help/en/captcha/captcha2-0/embed-web-client> |
| `GLM_CAPTCHA_SCENE` | `no8xfe` | Scene id created in the Captcha console. The captured default scene times out on real mints, so a real deployment needs its own. |
| `GLM_CAPTCHA_PREFIX` | `didk33e0` | Widget element-id prefix. |
| `GLM_CAPTCHA_REGION` | `sgp` | Widget region: `cn-hangzhou` or `sgp`. |
| `GLM_CAPTCHA_VERIFY_URL` | `https://captcha.aliyun.com/captcha/v3/verify` | Where the hub POSTs `{sceneId, appkey, data}`. |

The hub does **not** accept or sign with a RAM AccessKey. `verifyCaptchaParam()` in `server/hub.mjs` posts the scene id, public appkey and serialized param as form fields to `GLM_CAPTCHA_VERIFY_URL`, then treats Aliyun code `100` as valid. Aliyun's signed `VerifyIntelligentCaptcha` OpenAPI and its RAM policy are relevant if you build a different verifier; they are not wired into this repo.

**Gotchas:**

- Intl and China editions have separate consoles and configs. `sgp` is intl-only. A scene id and `GLM_CAPTCHA_REGION` must agree.
- An overdue account can lose its configs. Set a balance alert if you rely on pay-as-you-go.
- A `500 InternalError` from Aliyun leaves the donation `unverified`; the hub does not silently treat it as valid.

RAM policy docs, for reference: <https://www.alibabacloud.com/help/en/captcha/captcha2-0/grant-permissions-to-a-ram-user>. Signed server-side verify API: <https://www.alibabacloud.com/help/en/captcha/captcha2-0/integrate-server-side-verification-code>.

---

## 2. chat.z.ai OpenAI-compatible API

**What it is:** Z.ai's hosted GLM models, exposed through an OpenAI-compatible API. This repo's `z.ai/…` model ids target `https://chat.z.ai/api/v2/chat/completions` by default.

**Official docs:** <https://docs.z.ai/> - pricing: <https://docs.z.ai/guides/overview/pricing> - API keys: <https://z.ai/manage/apikey>

**Free tier facts, as researched on 2026-11-26:**

| Model | Price (in / out per 1M tokens) |
|---|---|
| GLM-4.7-Flash | **Free** |
| GLM-4.5-Flash | **Free** |
| GLM-4.6V-Flash | **Free** |
| GLM-5.3-Flash | $0.15 / $0.50 |
| GLM-5.3-FlashX | $0.37 / $1.25 |
| GLM-5.3 | $1.40 / $4.40 |

- Cached-input storage is limited-time free on paid models.
- Sign-up credit is campaign-based; it is not a standing free tier.

**GLM Coding Plan** is a subscription, not free. Legacy Plan V2 quotas: Lite about 80 prompts / 5 h and 400 / week; Pro about 400 / 5 h and 2,000 / week; Max about 1,600 / 5 h and 8,000 / week. Peak hours count more; off-peak counts less. Promo Nov 24 to Dec 24 2026 halves GLM-5.3-Flash consumption.
- Docs: <https://docs.z.ai/devpack/overview> - quotas: <https://docs.z.ai/devpack/tool/quota-consumption>

**Credential format:**

- An API key from <https://z.ai/manage/apikey> is sent as `Authorization: Bearer <key>`.
- This repo sends `GLM_UPSTREAM_KEY` as a bearer token to `GLM_UPSTREAM`, plus `x-fe-version`, `x-region` and a request signature from `GLM_SIGN_SALT`. It does not carry a chat.z.ai web session cookie.
- Official API bases are `https://api.z.ai/api/paas/v4` (standard) and `https://api.z.ai/api/coding/paas/v4` (Coding Plan). The Coding Plan URL bills the account balance without an active plan. Source: <https://docs.z.ai/devpack/tool/coding-plan-endpoint>.
- `chat.z.ai` and `api.z.ai` have separate sessions and terms. The default origin here is the web origin, with no SLA.

**Error codes from the official docs** (<https://docs.z.ai/api-reference/overview/error-code>): 1302 rate limit, 1308 usage limit, 1310 weekly or monthly cap, 1313 fair-usage frequency limit.

**Gotchas:**

- The three Flash models are the standing free tier on z.ai. GLM-5.3-Flash is paid there despite being free on bigmodel.cn at the time of research.
- Weekly and fair-use caps apply to paid accounts too.
- The web-origin path can change without notice.

---

## 3. chatglm.cn / Zhipu bigmodel.cn

**What it is:** Zhipu AI's China-facing platform (`bigmodel.cn`, `open.bigmodel.cn`) and its chat product `chatglm.cn`. This repo's `cn/…` model ids target `https://chatglm.cn/api/v1/chat/completions` by default.

**Official docs:** <https://docs.bigmodel.cn/> - pricing: <https://docs.bigmodel.cn/cn/guide/start/model-overview> - keys: <https://bigmodel.cn/usercenter/proj-mgmt/apikeys>

**Free tier facts, as researched on 2026-11-26:**

- Outright free (免费): GLM-4.7-Flash, GLM-4-Flash-250414, GLM-Z1-Flash, GLM-4.6V-Flash, GLM-4V-Flash, GLM-4.1V-Thinking-Flash, CogView-3-Flash, CogVideoX-Flash.
- Limited-time free (限时免费): GLM-5.3, GLM-5.3-Flash, GLM-5.3-FlashX, GLM-5.2, GLM-5.1, GLM-5-Turbo, GLM-5, GLM-4.7, GLM-4.5-Air, GLM-4.6V, GLM-OCR. These can revert to paid at any time. Cache-hit pricing is already paid even while generation is 限时免费.
- Trial credit (体验金) is valid for 30 days by default and can only be spent on model API calls. Source: <https://docs.bigmodel.cn/cn/terms/recharge-agreement> (section 2.3).
- Real-name verification grants 5 million free tokens and is required for Batch API. Source: <https://docs.bigmodel.cn/cn/faq/batch-api-issues>. Regular API calls do not require it: <https://docs.bigmodel.cn/cn/faq/authentication-issues>.
- Account balance is consumed in this order: trial credit, resource packs, cash.

**Credential format:**

- An API key from <https://bigmodel.cn/usercenter/proj-mgmt/apikeys> has the form `id.secret` and is sent as `Authorization: Bearer <key>`.
- Since 2026-10-16, standard keys and GLM Coding Plan keys are separate. Using the wrong type returns error 1315. Source: <https://docs.bigmodel.cn/cn/guide/start/api-key>.
- Official API bases: `https://open.bigmodel.cn/api/paas/v4` (standard), `https://open.bigmodel.cn/api/coding/paas/v4` (Coding Plan), `https://open.bigmodel.cn/api/anthropic`. The repo's default `cn/` origin is the web origin, not these API bases.
- Signup needs a +86 phone number in practice. Overseas users usually use z.ai instead.
- Per-model concurrency is account-specific: <https://bigmodel.cn/usercenter/proj-mgmt/rate-limits>.

---

## 4. Tor / SOCKS5 proxies

**What it is:** Tor exposes a free local SOCKS5 endpoint. This repo can route selected outbound calls through SOCKS5 endpoints listed in `GLM_EGRESS_ROUTES`.

**Official docs:**

- Tor manual: <https://2019.www.torproject.org/docs/tor-manual.html.en> (2019 snapshot)
- Circumvention / bridges: <https://support.torproject.org/censorship/>
- Download: <https://www.torproject.org/download/>

**Free tier facts:**

- Tor is free and open source. No account and no quota.
- Default SOCKS5 port is `9050` on 127.0.0.1 (`SocksPort 9050`).
- Multiple `SocksPort` lines create separate circuits. `HTTPTunnelPort 8118` serves clients that only speak HTTP CONNECT.

**Repo configuration:**

```bash
GLM_EGRESS_ROUTES=127.0.0.1:9050
GLM_EGRESS_MODE=proxy
```

`GLM_EGRESS_ROUTES` is a comma-separated list of bare `host:port` values. There is no `socks5://` scheme and there is no `GLM_PROXY_URL`. One route is picked per call, round-robin. A failed handshake marks that route dead for `GLM_EGRESS_DEAD_MS` and the call falls back to direct with `x-glm-egress: direct-fallback`.

Only chat forwards and the shared upstream-key probe are routed. Captcha verification, the donation exchange and `/status`-style calls stay direct. `server/hub.mjs` states this in `/status.egress.note`.

**Bridges and obfs4, when Tor itself is blocked:**

```tor
UseBridges 1
Bridge obfs4 <ip>:<port> <fingerprint> cert=<cert> iat-mode=0
ClientTransportPlugin obfs4 exec /usr/bin/obfs4proxy
```

- Bridge generator: <https://bridges.torproject.org> or `bridges@torproject.org`.
- obfs4: <https://community.torproject.org/pluggable-transports/obfs4/>

**Gotchas:**

- Tor exit IPs are heavily blocked by anti-abuse systems. Expect captchas and 403s on chat.z.ai; Aliyun captcha verification stays direct.
- Circuit routing adds latency.
- Tor SOCKS5 proxies TCP streams only.
- Windows Tor Expert Bundle: <https://www.torproject.org/download/tor/>.
- Running a Tor client is legal in most jurisdictions. Running an exit relay from a cloud provider usually violates the provider's acceptable-use policy.
- Public free proxy lists are unreliable and sniffable. For production, a paid SOCKS5 service is safer than either.

---

## Summary table

| Service | Free tier | Key credential | Repo integration | Primary gotcha |
|---|---|---|---|---|
| Aliyun Captcha 2.0 | Pay-as-you-go, no standing free quota; trial packs may exist | Public appkey + scene id | Browser mints, hub POSTs appkey/scene/param to the verify URL | Region mismatch; captured scene times out |
| chat.z.ai | GLM-4.7-Flash / 4.5-Flash / 4.6V-Flash are free | Bearer API key | `GLM_UPSTREAM`, `GLM_UPSTREAM_KEY`, `x-signature` | 429 codes 1302/1308/1310/1313; no SLA on web origin |
| bigmodel.cn | 8+ models free; flagships 限时免费; 30-day 体验金; 5M tokens with real-name | Bearer key `id.secret` | Same env vars with a `cn/…` model id | Needs +86 phone; error 1315 for wrong key type |
| Tor SOCKS5 | Free, unlimited | None | `GLM_EGRESS_ROUTES=127.0.0.1:9050` | Exit IPs blocked; only chat and key probes are routed |
