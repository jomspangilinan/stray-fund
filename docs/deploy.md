# Deploying Stray Fund

Stray Fund runs as one web service, one worker and one Postgres database on Render, with photos in two S3 buckets. Everything is declared in `render.yaml`. This guide covers what you do by hand.

Do the steps in this order.

Each safeguard below is marked **Demo ok** (the sandbox demo can run without it) or **Required before real money**. The list of everything marked required is in "Before real money" near the end. Nothing in this guide has been run against a real AWS account or live PayPal; it was written from the official pages named beside each step.

## 1. S3 buckets

Make two buckets in the same region as the app, `ap-southeast-1`. Bucket names are global, so pick your own, for example `strayfund-private-<something>` and `strayfund-public-<something>`.

| Bucket | Holds | Access |
| --- | --- | --- |
| Private (`S3_PRIVATE_BUCKET`) | Original photos under `originals/` | All four "Block public access" boxes on. Nothing reads it except the app and worker, through the IAM key. |
| Public (`S3_PUBLIC_BUCKET`) | Scrubbed copies under `photos/` | Readable by anyone for `photos/*` only. See below. |

Both: Object Ownership "Bucket owner enforced" (the default) and default encryption on (SSE-S3 is the default for every bucket). The code sends no ACLs.

**Public bucket.** The browser loads cat photos straight from this bucket, so `photos/*` must be readable by anyone. S3 Block Public Access has four independent settings (https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html). A public bucket policy is only accepted when two are off, and the two ACL settings can stay on, because the code sends no ACLs:

| Setting (API name) | On this public bucket |
| --- | --- |
| `BlockPublicAcls` | On |
| `IgnorePublicAcls` | On |
| `BlockPublicPolicy` | **Off**, or S3 rejects the policy below |
| `RestrictPublicBuckets` | **Off**, or S3 ignores the policy for everyone outside your account |

In the console these are the four checkboxes under the bucket's Block public access settings; untick only the third and fourth ("...through new public bucket or access point policies" and "Block public and cross-account access to buckets and objects through any public bucket or access point policies"). The **account-level** Block Public Access must not have those two on either: S3 applies the most restrictive of the bucket and the account, so an account-wide `BlockPublicPolicy` would reject this policy. This is the cost of the public bucket, and a reason to move to CloudFront (below) before real users upload photos. **Demo ok.**

Bucket policy for the public bucket (replace the bucket name). The second statement refuses plain HTTP, as AWS recommends with `aws:SecureTransport` (https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html). The app uses HTTPS already, so it changes nothing for it:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadScrubbedPhotos",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::YOUR-PUBLIC-BUCKET/photos/*"
    },
    {
      "Sid": "DenyPlainHttp",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::YOUR-PUBLIC-BUCKET",
        "arn:aws:s3:::YOUR-PUBLIC-BUCKET/*"
      ],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
```

Anyone on the internet can read `photos/*`, so only scrubbed copies may ever be written there, and the policy must never grow past that prefix. Check it after every edit (IAM Access Analyzer for S3 flags a bucket that is public). **Required before real money:** the TLS deny on both buckets, and the decision below on CloudFront.

The private bucket gets the same TLS deny and nothing else (all four Block Public Access settings stay on):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyPlainHttp",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::YOUR-PRIVATE-BUCKET",
        "arn:aws:s3:::YOUR-PRIVATE-BUCKET/*"
      ],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
```

Set `S3_PUBLIC_BASE_URL` to `https://YOUR-PUBLIC-BUCKET.s3.ap-southeast-1.amazonaws.com`. The app builds photo URLs as that base plus `/photos/<uuid>.jpg`.

**CloudFront, a later option (not needed for the demo, not set up by this repo).** To keep the public bucket fully blocked, put a CloudFront distribution in front of it with origin access control (OAC). AWS recommends OAC over the older origin access identity (https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html, checked: the page says Object Ownership must be "Bucket owner enforced" and gives a bucket policy for the principal `cloudfront.amazonaws.com` with `s3:GetObject` and an `AWS:SourceArn` condition on the distribution). It needs Object Ownership "Bucket owner enforced" (already set here) and a bucket policy that lets the principal `cloudfront.amazonaws.com` do `s3:GetObject` on `photos/*` only when `AWS:SourceArn` is your distribution. Then turn all four Block Public Access settings back on, delete the `PublicReadScrubbedPhotos` statement, and set `S3_PUBLIC_BASE_URL` to the CloudFront domain. Do this before real users upload photos of real places.

**CORS.** None is needed. Phones send the photo to the app (`POST /api/spot`), and the app writes to S3 from the server. Photos are shown in plain `<img>` tags (`unoptimized`). Save image draws a canvas, but it never reads the bucket from the browser: the app fetches the public photo itself and serves it from its own address (`/api/cats/<id>/keepsake/photo`), so the canvas is never tainted and the public bucket still needs no CORS rule. The web service does need to reach `S3_PUBLIC_BASE_URL` over https.

## 2. Account safety and the IAM role

**Root account (Demo ok, but do it first).** Sign in as the root user only to set this up. Turn on MFA for root (AWS requires it for every account type; there is a 14 day grace period) and create no access keys for root (https://docs.aws.amazon.com/IAM/latest/UserGuide/root-user-best-practices.html). Use a strong unique password and an email you control. For the command line on your laptop, `aws login` gives temporary credentials, so no root key is ever stored.

**An IAM role, no access keys (Demo ok, and the standard before real money).** Render signs each service in to AWS with a short-lived OIDC token, so no AWS secret is stored anywhere (https://render.com/docs/oidc). This needs a Render **Pro** workspace or higher. The AWS SDK's default credential chain reads the token by itself (`AWS_ROLE_ARN` plus `AWS_WEB_IDENTITY_TOKEN_FILE`), so the app needs no code for it.

1. Find the workspace id (starts with `tea-`) in the Render dashboard's workspace Settings URL.
2. IAM, Identity providers, add an OpenID Connect provider: URL `https://oidc.render.com/<WORKSPACE_ID>`, audience `sts.amazonaws.com`.
3. Create the role `stray-fund-app` with this trust policy, and attach the permissions policy below to it as an inline policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/oidc.render.com/WORKSPACE_ID" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": { "oidc.render.com/WORKSPACE_ID:aud": "sts.amazonaws.com" },
        "StringLike": { "oidc.render.com/WORKSPACE_ID:sub": "workspace:WORKSPACE_ID:environment:*:service:*" }
      }
    }
  ]
}
```

4. Put the role's ARN in `AWS_ROLE_ARN` on the web service and the worker. Render sets `AWS_WEB_IDENTITY_TOKEN_FILE` itself; never set it by hand.
5. Once Render shows the two service ids (`srv-...`), narrow the `sub` condition from `service:*` to exactly those two services, so no other service in the workspace can take the role.

Both services share one role because they run the same photo and model code. If their code paths diverge, give each its own role with a narrower policy. Without a Pro workspace, the fallback is one IAM user per service with its own access key, rotated every 90 days; the role removes that chore and the stored secret.

Replace the placeholders in the policy: `YOUR-PRIVATE-BUCKET`, `YOUR-PUBLIC-BUCKET`, `ACCOUNT_ID` (your 12 digit account number) and `REGION` (`ap-southeast-1`). The three `Bedrock...` statements are needed for the photo checks and the treasurer agent, which only ever use Bedrock in production; without them the deployed app cannot call the model.

**First use of Anthropic models on Bedrock (do this once per AWS account, before the first real call).** AWS enables most serverless models on first invoke, but two things must be in place or the first calls return `AccessDeniedException` (https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html). (1) Anthropic requires first-time customers to submit use case details once per account (or once at the organization's management account): open an Anthropic model in the Bedrock console model catalog and fill in the form, which asks for a description of the use and a website URL (a GitHub or project page is accepted for an individual). It can sit in a pending state with calls still denied; AWS emails when it finishes. (2) The identity that makes the first call needs `aws-marketplace:Subscribe`, `aws-marketplace:Unsubscribe` and `aws-marketplace:ViewSubscriptions`, or someone who has them must enable the model once; after that the app's own policy does not need them. These Marketplace actions are not in the policy below on purpose, so use an admin identity for the first call, not the app's role. The account also needs a valid payment method. After the subscription starts, allow up to 15 minutes, and up to 2 minutes after fixing a missing permission.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PrivatePhotos",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::YOUR-PRIVATE-BUCKET/originals/*"
    },
    {
      "Sid": "PublicPhotos",
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::YOUR-PUBLIC-BUCKET/photos/*"
    },
    {
      "Sid": "BedrockGlobalProfileInRegion",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": "arn:aws:bedrock:REGION:ACCOUNT_ID:inference-profile/global.anthropic.claude-haiku-4-5-20251001-v1:0",
      "Condition": { "StringEquals": { "aws:RequestedRegion": "REGION" } }
    },
    {
      "Sid": "BedrockRegionalModel",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": "arn:aws:bedrock:REGION::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
      "Condition": {
        "StringEquals": {
          "aws:RequestedRegion": "REGION",
          "bedrock:InferenceProfileArn": "arn:aws:bedrock:REGION:ACCOUNT_ID:inference-profile/global.anthropic.claude-haiku-4-5-20251001-v1:0"
        }
      }
    },
    {
      "Sid": "BedrockGlobalModel",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": "arn:aws:bedrock:::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
      "Condition": {
        "StringEquals": {
          "aws:RequestedRegion": "unspecified",
          "bedrock:InferenceProfileArn": "arn:aws:bedrock:REGION:ACCOUNT_ID:inference-profile/global.anthropic.claude-haiku-4-5-20251001-v1:0"
        }
      }
    }
  ]
}
```

The three `Bedrock...` statements are the three-part policy AWS documents for a `global.` inference profile (https://docs.aws.amazon.com/bedrock/latest/userguide/global-cross-region-inference.html): the profile in your region, the regional model reached through that profile, and the region-less global model ARN (`arn:aws:bedrock:::foundation-model/...`, where AWS sets `aws:RequestedRegion` to `unspecified`). All three are needed; removing any one denies the call. They name one model and one profile, with no wildcards. The app calls `InvokeModel` without streaming, so nothing else is allowed. If you change `AI_MODEL`, change the model name in all three statements. If your organisation uses a Service Control Policy that blocks unused regions, it must allow `unspecified` for Bedrock (same page).

The code only calls `PutObject` and `GetObject` on S3, so the policy grants nothing else (no `ListBucket`, no delete). One side effect to expect: S3 answers a missing key with 403 instead of 404 when the caller cannot list the bucket, so a missing original shows as an access error. Live check 7 below will show it.

**Bedrock sends the photo to other regions.** A `global.` profile may process a request in any supported commercial region. If photos could show people, decide whether that is acceptable for your users; a geographic profile keeps processing in one geography, and its availability for this model has not been checked. **Required before real money:** decide this, and test one real model call with this exact policy (ask first: it costs money and needs your OK).

## 3. Billing alert

Before anything else is running up costs, open AWS Billing, Budgets, and create a monthly cost budget (for example 20 USD) with an email alert at 80 percent of actual spend. Also turn on "Receive Billing Alerts" in Billing preferences. Bedrock is the line most likely to surprise you. `AI_DAILY_CALL_CAP` (100 in the Blueprint; the code default is 500) is the app-side limit and the only hard stop (pending photos older than 24 hours also go to a person and get no more AI calls): AWS updates budget data up to three times a day, so an alert can arrive hours late and does not stop spending. **Required before real money.**

## 4. Render Blueprint

1. Push the repo to GitHub, then in Render choose New, Blueprint, and pick the repo.
2. Render reads `render.yaml` and shows the three resources. It asks for every variable marked `sync: false` (see the table). It asks once per service, so enter the shared ones twice, in web and in worker.
3. Create. The first deploy builds, runs `npm run db:migrate` as the pre-deploy step on the web service, then starts. The worker deploys on its own and may start before the migration finishes. If it crashes on a missing table, redeploy it once the web service is live.

Paid tiers are used on purpose: free Postgres expires after 30 days and workers have no free tier.

## 5. Secrets

- `SESSION_SECRET` and `FEEDER_TOKEN` are generated by Render. Read `FEEDER_TOKEN` in the web service's Environment tab; the feeder device sends it as `Authorization: Bearer <token>`.
- There are no AWS keys. Put the role's ARN in `AWS_ROLE_ARN` on both services (step 2). It is not a secret, but it is kept out of the YAML so the repo names no account.
- Put your PayPal sandbox app's client id and secret in `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` on both services.
- `PAYPAL_VET_EMAIL` is the sandbox account that receives vet payouts.
- Never paste any of these into the repo or the YAML.

## 6. PayPal webhook

In the PayPal developer dashboard, open your sandbox app, add a webhook with the URL `https://<your-web-service>.onrender.com/api/webhooks/paypal`, and subscribe to these events (names from https://developer.paypal.com/api/rest/webhooks/event-names/):

| Event | What the app does |
| --- | --- |
| `PAYMENT.CAPTURE.COMPLETED` | Records the donation as captured, once. |
| `PAYMENT.CAPTURE.REFUNDED` | "A merchant refunds a payment capture." Writes a negative refund row linked to the donation, with the amount and fee effect PayPal reports. |
| `PAYMENT.CAPTURE.REVERSED` | "PayPal reverses a payment capture." This is the chargeback money event. Same, as a reversal row. |
| `PAYMENT.CAPTURE.DENIED` | "A payment capture is denied." Takes back what the donation still held, if it had been recorded as captured. |
| `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `.FAILED`, `.BLOCKED`, `.CANCELED`, `.HELD`, `.UNCLAIMED`, `.RETURNED`, `.REFUNDED` | Keeps vet payouts in step (the `PAYMENT.PAYOUTS-ITEM.*` family). |

The `CUSTOMER.DISPUTE.*` events are not needed: a dispute moves no money by itself, and the money event is `PAYMENT.CAPTURE.REVERSED`. Subscribing to them does no harm, they are acknowledged and ignored. `PAYMENT.PAYOUTSBATCH.*` is also not needed, because the worker polls each batch.

If a capture webhook is lost, the worker asks PayPal about any donation still pending after 5 minutes (up to 72 hours old, ten at a time, with growing waits, and a batch ends early on a rate limit) and records an order PayPal says is COMPLETED through the same path as the webhook, so the money is counted once either way. The worker only records. It never captures: an order the donor approved but nobody captured may be one the page told them had failed and they paid again, so only the donor's own tap captures. VOIDED orders are asked about once. A 404 is asked about again after a back-off, because wrong credentials look the same; two in a row open a question. Only CREATED and SAVED count as holding no money; any other answer stays open. A COMPLETED order that cannot fit its donation (amount mismatch or unknown order), a row that reaches 72 hours with its last check unresolved, and a row that was never checked at all, each open one question on the caretaker desk ("A PayPal donation is not in the ledger"). A transient database error does not open one; it backs off and tries again. The desk has no button to record such a donation: the question says to check it at PayPal and, if the money should stay, have a developer record it, or refund it there.

A refund or reversal never edits the donation. It is a separate row on the ledger (type Refund, negative), the pool and the "where every peso went" line drop by exactly what PayPal reports, and the line says how much was taken back. If the money was already given to cats or paid out, the pool shows below zero, new funding is refused, nothing is clawed back, and a question appears on the caretaker desk under Treasurer questions. A refund the app cannot read or that is larger than its donation is not recorded; it opens a question instead. 
### 6b. Webhook id

After saving the webhook, copy its id from the dashboard into `PAYPAL_WEBHOOK_ID` on the web service. Until it is set, every webhook is rejected on purpose. If Render will not accept an empty value at Blueprint creation, enter a placeholder and replace it here.

## 7. First boot check

- `https://<web>.onrender.com/api/health` returns `{"ok":true,"db":true}`.
- The home page, `/cats` and `/ledger` load.
- The worker's logs show `[worker] started`.
- Use the demo persona switcher, then try one spot with a photo and confirm the cat photo shows on the page (this proves both buckets and the base URL).

## Variables

| Variable | Service | Where the value comes from |
| --- | --- | --- |
| `NODE_ENV` | web, worker | Fixed to `production` in the Blueprint |
| `NODE_VERSION` | web, worker | Fixed to `22` in the Blueprint (Render build setting) |
| `DATABASE_URL` | web, worker | Linked to the database by the Blueprint |
| `SESSION_SECRET` | web | Generated by Render |
| `FEEDER_TOKEN` | web | Generated by Render |
| `DEMO_MODE` | web | Fixed to `true` in the Blueprint |
| `AWS_REGION` | web, worker | Fixed to `ap-southeast-1` |
| `AWS_ROLE_ARN` | web, worker | The `stray-fund-app` role, step 2. Render adds `AWS_WEB_IDENTITY_TOKEN_FILE` itself |
| `AI_MODEL` | web, worker | Fixed Bedrock model id (the code default) |
| `AI_DAILY_CALL_CAP` | web, worker | Fixed to `100`; change in the dashboard |
| `S3_PRIVATE_BUCKET` | web, worker | Bucket name, step 1 |
| `S3_PUBLIC_BUCKET` | web, worker | Bucket name, step 1 |
| `S3_PUBLIC_BASE_URL` | web, worker | Public bucket URL, step 1 |
| `PAYPAL_ENV` | web, worker | Fixed to `sandbox`. Only `production` switches to live PayPal. |
| `PAYPAL_CLIENT_ID` | web, worker | PayPal developer dashboard, sandbox app |
| `PAYPAL_CLIENT_SECRET` | web, worker | PayPal developer dashboard, sandbox app |
| `PAYPAL_VET_EMAIL` | web | Sandbox vet account email |
| `PAYPAL_WEBHOOK_ID` | web | PayPal webhook, step 6 |

Subscription mode (`AI_PROVIDER=claude-cli`, the treasurer and the photo checks through `claude -p`) is for local tests only. Production and any claim about the deployed app use Bedrock, which must get one real check, asked for first, before filming. Results on the subscription route do not prove Bedrock's model behaves the same. The CLI runs with no tools and `--safe-mode` (no CLAUDE.md, hooks, plugins or user settings), but it still uses the developer's own login and HOME (`CLAUDE_CONFIG_DIR` also stays allowlisted in `src/server/ai/cli.ts`), and admin-managed policy settings on that machine still apply.

Not set in production on purpose: `STORAGE_DRIVER` (defaults to `s3` and refuses anything else), `AI_PROVIDER` (production always uses Bedrock), `AI_CLI_MODEL` and `AWS_PROFILE` (local only), `TEST_DATABASE_URL` (tests only).

## Monthly cost

Prices from render.com/pricing on 2026-11-03.

| Item | Plan | USD per month |
| --- | --- | --- |
| Web service | `0.5c-512mb` | 7 |
| Worker | `0.5c-512mb` | 7 |
| Postgres | `0.1c-256mb` | 6 |
| Postgres storage | 1 GB at 0.30 | 0.30 |
| Pro workspace | flat fee, needed for the OIDC role | 25 |
| Render total | | about 45.30 |

S3 storage and requests for a demo are cents. Bedrock is pay per call and capped by `AI_DAILY_CALL_CAP`. The Render workspace must be on Pro (25 USD a month, flat) for the OIDC role in step 2.

## Live checks to run after the first deploy

These were postponed because they cannot run on a laptop.

1. Real PayPal webhooks: send a test and a real sandbox capture, check the signature passes, and compare the payload shape with `tests/fixtures/paypal/`.
2. A donation captured through the UI end to end.
3. Phone camera over HTTPS on Safari (iPhone) and Chrome (Android).
4. The 390 px layout on every page.
5. The Cat Yard error state (stop the database or break the request and look at the page).
6. The feeder running for 10 minutes on a phone.
7. Real S3: upload, scrub, public URL loads, the private bucket refuses a direct request.
8. The cat detector on a phone (model files load from `/models/cat-detector-v1/`).
9. A real sandbox refund of a captured donation: confirm `PAYMENT.CAPTURE.REFUNDED` arrives and that its payload matches what the app reads (`id`, `status`, `seller_payable_breakdown`, and an `up` link to the capture). The app was built from PayPal's schema, not from a recorded payload.
10. A real chargeback or reversal cannot be staged in the sandbox from the app, so `PAYMENT.CAPTURE.REVERSED` and `PAYMENT.CAPTURE.DENIED` stay unverified until one happens. If PayPal sends no amounts, the app takes back what the donation still held in net and opens no guess about fees.
11. Lost-webhook recovery: capture a sandbox order, stop the webhook (wrong URL), wait about 10 minutes, and watch the worker log. The donation should appear on the ledger. Also approve an order and close the page before the app captures it: the worker must NOT capture it (it stays pending, is asked about with growing waits, and shows as unresolved; nothing is charged). Check the worker's PayPal call rate against the sandbox limit.
12. A repeated payout `sender_batch_id` on live PayPal, with a tiny amount (see below).
13. A refund that stays PENDING: PayPal's refund status can be PENDING before COMPLETED. The app does not apply it while PENDING; confirm that the same refund id arrives again as COMPLETED (a `PAYMENT.CAPTURE.REFUNDED` event or the order's `refunds[]`) and is applied then, once.
14. A refund webhook that PayPal never delivers, on an already captured donation: the app does not poll for it (see Before real money). Stage one in the sandbox by pointing the webhook at a wrong URL, refund, and confirm the pool does NOT change, so you know what a lost refund looks like.
15. A payout item that PayPal reports BLOCKED or REVERSED: the payout goes to Payouts under review and keeps its reservation. The desk says "Check this at PayPal. A developer must close it." and offers no "not paid" button, on purpose: once a payout has a batch id at PayPal, nothing may create a new payout for that booking and kind unless PayPal itself reports the money did not leave or came back. This cannot be staged easily in the sandbox.
16. A payout PayPal reports SUCCESS after the fund called it failed: it shows under Payouts under review with Paid and Not paid. The treasurer may never ask for that booking and kind again, whatever happens to the question. Paid is offered only while PayPal's latest status is SUCCESS and makes it succeeded in the books; Not paid is offered only after PayPal says RETURNED, REFUNDED or REVERSED, needs a note, and lifts the block (a later SUCCESS flags it again).
17. A payout rejected, or refused outright on its first and only send, that PayPal never saw: the desk offers "Allow a new try" with a note, which gives the treasurer exactly one more try. A row that may have reached PayPal never gets it, and nobody can rule it "not paid": that is a batch id, a PayPal status, more than one send attempt, a BATCH_EXISTS flag, or an unknown-outcome error. "No batch id" does not mean PayPal never got it (a first send can time out after PayPal took it). Only PayPal saying FAILED, RETURNED, REFUNDED or CANCELED frees such a row for the treasurer. A late-success row ruled "Not paid" after REVERSED stays blocked for the same reason, so a developer closes it.
18. The report flow on the deployed app, with the real worker and Bedrock: take a spot photo with the phone camera, tap Hurt and add a note with a made-up phone number and street. Check that the cat shows under "Needs a person first" on `/priority` with no note text, that the caretaker desk shows the report first (the open demo hides a visitor's note, so only seeded `sample` notes read in full), and that `/api/priority` and the cat page hold neither the note nor the exact place. Confirm it as the caretaker and watch the worker log for a `report_changed` run. Check that the cat is still not funded, then clear it as the vet and check that it is. Then read the Treasurer's reason on `/priority` and the cat's timeline: it should name who goes first and who waits, and a reason that repeats the note must show as the fixed line. No new variable is needed. Run `scripts/check-public-leaks.ts` against a throwaway copy of the deployed setup first (its header says how). `[CONFIRM AFTER LIVE RUN]`
19. The Treasurer's weighing on Bedrock. The prompt evaluation in `.superpowers/sdd/2026-11-04-ai-priority-list/prompt-eval.md` ran on the local `claude -p` route only. Ask the owner before any Bedrock call, then re-run its cases once each, starting with the forged receipt, and compare.

## Before real money

Everything here is **required before real money**. None of it is needed for the sandbox demo.

- Root account has MFA and no access keys (step 2).
- A billing alert exists, and you accept that the only hard stop is `AI_DAILY_CALL_CAP` (step 3).
- The role's `sub` condition narrowed to the two service ids, and no IAM user or access key for the app (step 2).
- The Bedrock policy in step 2 tested with one real call, and a decision on `global.` processing in other regions.
- TLS-only deny policy on both buckets, and the CloudFront OAC decision made for the public photo bucket (step 1).
- A separate live PayPal app, its own live webhook id, subscribed to every event in step 6, and `PAYPAL_ENV=production` set by hand. Nothing in `render.yaml` ever sets it.
- The refund, reversal and lost-webhook checks above (9 to 11, 13, 14) run in the sandbox first.
- Known gaps, not fixed: a refund whose webhook was lost, on a donation already captured, is not polled, so the pool stays too high until someone records it; and a chargeback fee (PayPal's dispute fee) is not modelled, only the reversed amount. Decide who watches PayPal for both.
- One live payout repeated with the same `sender_batch_id` for a tiny amount (check 12). PayPal documents only that a repeat within 30 days is rejected "with an error message that shows the duplicate sender_batch_id"; the app files any rejection it cannot read, on a retry, under review, and never pays a second time, so this check only tells you how often a person will be asked.
- Verified sign-in accounts instead of the demo role switcher (see the README).
- A payout stuck in review with a batch id at PayPal (BLOCKED, REVERSED or any status PayPal has not settled) has no desk button to clear it; a developer closes it after checking PayPal. This is deliberate, so a stuck payout is never paid twice. Plan who that developer is.
- A pool that goes below zero after a refund is shown as it is and funding stops. Decide who on the caretaker desk answers that question and how the gap is covered; the app never takes money back by itself.
- Payout gaps in the "may have reached PayPal" rule, known and not fixed. One list:
  - The reconcile worker skips failed rows, so a failed payout with no batch id is only corrected when a webhook arrives.
  - The server has no live-sibling check on "Allow a new try" (the desk lists it only when nothing live is on the booking and kind); the unique index is the last guard.
  - "Paid" on a late-success row that has a live sibling payout hits the unique index and fails.
  - Two failed rows that both have batch ids need a developer; no desk action reaches them.
