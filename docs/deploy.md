# Deploying Stray Fund

Stray Fund runs as one web service, one worker and one Postgres database on Render, with photos in two S3 buckets. Everything is declared in `render.yaml`. This guide covers what you do by hand.

Do the steps in this order.

## 1. S3 buckets

Make two buckets in the same region as the app, `ap-southeast-1`. Bucket names are global, so pick your own, for example `strayfund-private-<something>` and `strayfund-public-<something>`.

| Bucket | Holds | Access |
| --- | --- | --- |
| Private (`S3_PRIVATE_BUCKET`) | Original photos under `originals/` | All four "Block public access" boxes on. Nothing reads it except the app and worker, through the IAM key. |
| Public (`S3_PUBLIC_BUCKET`) | Scrubbed copies under `photos/` | Readable by anyone for `photos/*` only. See below. |

Both: Object Ownership "Bucket owner enforced" (the default), default encryption on. The code sends no ACLs.

**Public bucket.** The browser loads cat photos straight from this bucket, so `photos/*` must be readable by anyone. In the bucket's Block public access settings, turn off only "Block public access to buckets and objects granted through new public bucket or access control policies" and "Block public and cross-account access to buckets and objects through any public bucket or access control policies". Leave the two ACL boxes on. Then add this bucket policy (replace the bucket name):

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
    }
  ]
}
```

Set `S3_PUBLIC_BASE_URL` to `https://YOUR-PUBLIC-BUCKET.s3.ap-southeast-1.amazonaws.com`. The app builds photo URLs as that base plus `/photos/<uuid>.jpg`. If you would rather keep this bucket fully blocked, put CloudFront in front with origin access control and use the CloudFront domain as the base URL. That is more setup and is not needed for the demo.

**CORS.** None is needed. Phones send the photo to the app (`POST /api/spot`), and the app writes to S3 from the server. Photos are shown in plain `<img>` tags (`unoptimized`). Save image draws a canvas, but it never reads the bucket from the browser: the app fetches the public photo itself and serves it from its own address (`/api/cats/<id>/keepsake/photo`), so the canvas is never tainted and the public bucket still needs no CORS rule. The web service does need to reach `S3_PUBLIC_BASE_URL` over https.

## 2. IAM key

Make an IAM user with no console access, attach the policy below, and create one access key. Use the same key for web and worker. Do not use root keys.

Replace the two bucket names. `BedrockOptional` is optional and needs your OK before you add it. Without it the photo checks and the treasurer agent cannot call the model (production only ever uses Bedrock), so the deployed app is limited without it.

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
      "Sid": "BedrockOptional",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": [
        "arn:aws:bedrock:*:*:inference-profile/global.anthropic.claude-haiku-4-5-20251001-v1:0",
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0"
      ]
    }
  ]
}
```

The code only calls `PutObject` and `GetObject`. The Bedrock resource ARNs follow the AWS pattern for a global inference profile and have not been tried against a real call. If the first model call is denied, the error names the ARN it wanted. If you change `AI_MODEL`, change these two lines too.

## 3. Billing alert

Before anything else is running up costs, open AWS Billing, Budgets, and create a monthly cost budget (for example 20 USD) with an email alert at 80 percent of actual spend. Also turn on "Receive Billing Alerts" in Billing preferences. Bedrock is the line most likely to surprise you. `AI_DAILY_CALL_CAP` (500 by default) is the app-side limit.

## 4. Render Blueprint

1. Push the repo to GitHub, then in Render choose New, Blueprint, and pick the repo.
2. Render reads `render.yaml` and shows the three resources. It asks for every variable marked `sync: false` (see the table). It asks once per service, so enter the shared ones twice, in web and in worker.
3. Create. The first deploy builds, runs `npm run db:migrate` as the pre-deploy step on the web service, then starts. The worker deploys on its own and may start before the migration finishes. If it crashes on a missing table, redeploy it once the web service is live.

Paid tiers are used on purpose: free Postgres expires after 30 days and workers have no free tier.

## 5. Secrets

- `SESSION_SECRET` and `FEEDER_TOKEN` are generated by Render. Read `FEEDER_TOKEN` in the web service's Environment tab; the feeder device sends it as `Authorization: Bearer <token>`.
- Put the IAM key in `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` on both services.
- Put your PayPal sandbox app's client id and secret in `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` on both services.
- `PAYPAL_VET_EMAIL` is the sandbox account that receives vet payouts.
- Never paste any of these into the repo or the YAML.

## 6. PayPal webhook

In the PayPal developer dashboard, open your sandbox app, add a webhook with the URL `https://<your-web-service>.onrender.com/api/webhooks/paypal`, and subscribe to `PAYMENT.CAPTURE.COMPLETED` and the `PAYMENT.PAYOUTS-ITEM.*` events. Copy the webhook id into `PAYPAL_WEBHOOK_ID` on the web service. Until it is set, every webhook is rejected on purpose. If Render will not accept an empty value at Blueprint creation, enter a placeholder and replace it here.

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
| `AWS_ACCESS_KEY_ID` | web, worker | IAM access key, step 2 |
| `AWS_SECRET_ACCESS_KEY` | web, worker | IAM access key, step 2 |
| `AI_MODEL` | web, worker | Fixed Bedrock model id (the code default) |
| `AI_DAILY_CALL_CAP` | web, worker | Fixed to `500`; change in the dashboard |
| `S3_PRIVATE_BUCKET` | web, worker | Bucket name, step 1 |
| `S3_PUBLIC_BUCKET` | web, worker | Bucket name, step 1 |
| `S3_PUBLIC_BASE_URL` | web, worker | Public bucket URL, step 1 |
| `PAYPAL_ENV` | web, worker | Fixed to `sandbox`. Only `production` switches to live PayPal. |
| `PAYPAL_CLIENT_ID` | web, worker | PayPal developer dashboard, sandbox app |
| `PAYPAL_CLIENT_SECRET` | web, worker | PayPal developer dashboard, sandbox app |
| `PAYPAL_VET_EMAIL` | web | Sandbox vet account email |
| `PAYPAL_WEBHOOK_ID` | web | PayPal webhook, step 6 |

Subscription mode (`AI_PROVIDER=claude-cli`, the treasurer and the photo checks through `claude -p`) is for local tests only. Production and any claim about the deployed app use Bedrock, which must get one real check, asked for first, before filming. Results on the subscription route do not prove Bedrock's model behaves the same. The CLI runs with no tools and `--safe-mode` (no CLAUDE.md, hooks, plugins or user settings), but it still uses the developer's own login and HOME, and admin-managed policy settings on that machine still apply.

Not set in production on purpose: `STORAGE_DRIVER` (defaults to `s3` and refuses anything else), `AI_PROVIDER` (production always uses Bedrock), `AI_CLI_MODEL` and `AWS_PROFILE` (local only), `TEST_DATABASE_URL` (tests only).

## Monthly cost

Prices from render.com/pricing on 2026-11-03.

| Item | Plan | USD per month |
| --- | --- | --- |
| Web service | `0.5c-512mb` | 7 |
| Worker | `0.5c-512mb` | 7 |
| Postgres | `0.1c-256mb` | 6 |
| Postgres storage | 1 GB at 0.30 | 0.30 |
| Render total | | about 20.30 |

S3 storage and requests for a demo are cents. Bedrock is pay per call and capped by `AI_DAILY_CALL_CAP`. The Render workspace itself needs the free Hobby plan at least.

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
