# Free-Tier Deployment Quickstart

This guide maps the five gaps in `START-HERE.md` to credential sources and local checks. The hub itself has no runtime dependencies; external APIs may charge after a trial or outside their free models. Costs, quotas and console layouts change, so verify them at the linked official sources. Details are in `docs/FREE_TIER_RESEARCH.md`.

| Gap | Need | What is actually free | Verification |
|---|---|---|---|
| 1. chat.z.ai token | Bearer token for `GLM_UPSTREAM_KEY` | Sign up at <https://z.ai/>; GLM-4.7-Flash, GLM-4.5-Flash and GLM-4.6V-Flash are standing free. Key at <https://z.ai/manage/apikey>. | `node doctor.mjs live` after setting `GLM_UPSTREAM` and `GLM_UPSTREAM_KEY` in the environment. |
| 2. Aliyun scene | Scene id and prefix in the Captcha 2.0 console | No standing free quota. Trial packs may exist at <https://free.aliyun.com>; pay-as-you-go is a fraction of a cent per verification. | Mint a param in a real browser, then use admin `POST /captcha/verify` and read `/status`. |
| 3. Suffix features | Same token as gap 1, one model id per suffix | No extra credential. | `node doctor.mjs live z.ai/glm-4.7-think`, plus the `-search` and `-deepresearch` ids. Record each body and judge whether the feature fired. |
| 4. Minter tab stability | Real browser tab and half an hour | Local test, no credential. | Watch `minter.served` climb with no reconnect lines; compare a 390 px screenshot with the reference. |
| 5. chatglm.cn token | Bearer token for `GLM_UPSTREAM_KEY`, used with a `cn/…` model | <https://bigmodel.cn/>; requires +86 phone. Eight or more models were free on 2026-11-26, flagships were 限时免费, a 30-day 体验金 and 5M tokens with real-name auth. Check the current pricing table. | `node doctor.mjs live cn/glm-5.3` after setting the environment. |

## Set environment values before running `doctor.mjs`

`node doctor.mjs live [model]` takes only an optional model id. It reads `GLM_UPSTREAM` and `GLM_UPSTREAM_KEY` from the environment. On Windows PowerShell:

```powershell
$env:GLM_UPSTREAM='https://chat.z.ai'
$env:GLM_UPSTREAM_KEY='<your-key>'
node doctor.mjs live
```

The command starts its own hub, makes one real call and prints `PROVEN` or the refusal it received. It does not see a token contributed through a browser to another hub.

## Gap 1 and gap 3: chat.z.ai

1. Sign up at <https://z.ai/model-api>. No payment card is needed for the free models.
2. Create a key at <https://z.ai/manage/apikey>.
3. Set `GLM_UPSTREAM=https://chat.z.ai` and `GLM_UPSTREAM_KEY=<key>` in the shell or `.env`.
4. Run `node doctor.mjs live`. A pass prints `PROVEN` and a 200 completion body.
5. Repeat with `node doctor.mjs live z.ai/glm-4.7-think`, `z.ai/glm-4.7-search` and `z.ai/glm-4.7-deepresearch`. Record each response body and decide whether the suffix visibly did anything. The hub sets a feature flag; it cannot prove the upstream acted on it.

There is no `GLM_CHAT_SUFFIX` variable. A suffix is part of the model id.

## Gap 2: Aliyun Captcha

1. Sign up at <https://www.alibabacloud.com/product/captcha>. Check <https://free.aliyun.com> for current trial packs. Pricing is pay-as-you-go; there is no standing free quota.
2. In the Captcha 2.0 console, create a Scene in the region you will use. For the intl edition that is Singapore (`sgp`). Record the Scene ID (`no8xfe`-shaped) and client prefix (`didk33e0`-shaped).
3. Put those values in `.env`:

   ```bash
   GLM_CAPTCHA_SCENE=<your-scene-id>
   GLM_CAPTCHA_PREFIX=<your-prefix>
   GLM_CAPTCHA_REGION=sgp
   ```

4. Start the hub with `npm run hub:env`, sign in as admin, open a real minter tab and wait for a minted param to enter the pool.
5. Sign in as admin and `POST /captcha/verify` with `{fp, value}` from `/tokens?all=1`, or `{param}` with the serialized value. The route requires an admin session. `/status` reports the captcha counters.

This repo does not accept an Aliyun RAM AccessKey. The hub POSTs `{sceneId, appkey, data}` to `GLM_CAPTCHA_VERIFY_URL`; the appkey is the public demo value. RAM policies and signed `VerifyIntelligentCaptcha` calls belong to a different verifier, not this one. See `docs/FREE_TIER_RESEARCH.md` §1.

The captured scene (`no8xfe`) ends real mints at `captcha mint timeout`. A scene from your own console is part of what closes this gap.

## Gap 4: minter tab stability

No credential needed. Start the hub with `npm run hub:env`, open `http://127.0.0.1:5082/` in a real unminimised tab, sign in and open the minter. Watch `minter.served` in `/status` or the panel for 30 minutes. Reconnect lines mean a failed run. Capture a 390 px screenshot and name the elements that differ from the reference described in `HANDOFF.md` gap 4.

## Gap 5: chatglm.cn

1. Sign up at <https://bigmodel.cn/> with a +86 phone number.
2. Create a standard API key at <https://bigmodel.cn/usercenter/proj-mgmt/apikeys>. It has the form `id.secret`. A GLM Coding Plan key returns error 1315 here.
3. Check the pricing table at <https://docs.bigmodel.cn/cn/guide/start/model-overview>. Limited-time free models may revert to paid.
4. Set the environment before the check:

   ```powershell
   $env:GLM_UPSTREAM='https://chatglm.cn'
   $env:GLM_UPSTREAM_KEY='id.secret'
   node doctor.mjs live cn/glm-5.3
   ```

   Use a dot in the model id (`cn/glm-5.3`, not `cn/glm-5-3`). A pass prints `PROVEN` and a 200 body.

## Commands worth knowing

```bash
node doctor.mjs                  # what this machine has and what each gap needs
node doctor.mjs live             # one real z.ai call
node doctor.mjs live cn/glm-5.3  # one real chatglm.cn call
npm run check                    # structural, type and behavioural checks
```

There is no `npm run doctor` or `npm run doctor:live` script. `npm run hub:env` starts the hub from `.env`; `npm run hub` ignores `.env`.

## `.env` template

```bash
# Choose the upstream whose key you are using.
GLM_UPSTREAM=https://chat.z.ai
GLM_UPSTREAM_KEY=<key>

GLM_CAPTCHA_SCENE=<your-scene-id>
GLM_CAPTCHA_PREFIX=<your-prefix>
GLM_CAPTCHA_REGION=sgp

# Optional. Bare host:port, no socks5:// scheme.
# Chat forwards and the upstream-key probe use these routes; captcha calls stay direct.
# GLM_EGRESS_ROUTES=127.0.0.1:9050
# GLM_EGRESS_MODE=proxy

# Optional. Keep the people directory and unexpired minted params across restarts.
# GLM_STATE_FILE=../glm-state/people.json
```

Pin role keys, `SESSION_SECRET`, `GLM_PUBLIC_URL` and `GLM_TRUST_PROXY` for a longer-lived deployment. The annotated list is in `.env.example`; the reasons are in `README.md` under "Deploying it".

## Gotchas

- z.ai rate limits return 1302, 1308, 1310 or 1313. Free models have modest concurrency.
- GLM-5.3-Flash is free on bigmodel.cn at the time of research but paid on z.ai.
- Aliyun has no standing free quota. Overdue payment by more than 7 days can delete configs.
- Scene region and `GLM_CAPTCHA_REGION` must agree.
- chatglm.cn needs +86 SMS verification. Overseas users generally use chat.z.ai.
- A generated role key lasts one process lifetime. Pin `GLM_KEYS` or use a state file for identity that survives restarts.
- Tor SOCKS5 routes are free but exit IPs are widely blocked. The repo routes only chat forwards and the shared-token probe.

## After the gaps close

The five gaps cover credentials and observation. They do not turn the hub into a hosted service. You still choose one always-on process, one volume and a TLS terminator; see `README.md` "Deploying it" for the reasons and `INSTRUCTION.md` for the operator checklist.

Research source: `docs/FREE_TIER_RESEARCH.md`. Verification: `node doctor.mjs` and `node doctor.mjs live`. For the system itself, read `START-HERE.md`, `HANDOFF.md` and `README.md`.
