# Stray Fund

DRAFT for the owner to check. Working name; the name lives in one constant, `APP_NAME` in `src/lib/config.ts`.

A shared fund for one neighbourhood's stray cats. Neighbours spot cats and donate. An AI treasurer picks which cat gets neutered next. Rules check every payment before it goes out, and a person signs off before the last of the money moves. Every peso shows on a public ledger.

Built for the PayPal AI Hackathon. It runs on PayPal sandbox money only.

## The problem

Strays multiply when they are fed but not neutered. Neighbours want to help, but they don't know where a donation goes, and the cutest cat gets all the attention. The cat that has waited longest, or is pregnant, or is hurt, gets none.

## How it works

1. **Spot.** A neighbour takes a live camera photo of a cat. Old photos can't be uploaded. The AI checks that it is a real cat, matches it to a known cat or makes a new card, and blurs people, signs and plates before anything is public.
2. **Ear-tip.** The AI does not judge ear-tips; in tests it got them wrong. Neighbours answer Yes, No or Not sure. Two different people saying No queue the cat. A caretaker settles any disagreement.
3. **Donate.** Neighbours give through PayPal Checkout into one shared fund. Fees are counted, so the fund only holds what arrived.
4. **Decide.** The AI treasurer looks at the waiting cats and the fund, picks one and writes why, in plain words.
5. **Pay the deposit.** Rules check the payee, the caps and the fund. If they pass, the partner vet gets a deposit through PayPal Payouts.
6. **Prove it.** The vet sends a receipt and a photo of the cat's ear. The AI reads the receipt; code compares it with the booking. A caretaker looks at the photo and taps "I saw the ear-tip".
7. **Pay the balance.** Only after that, the rest is paid. The cat's card is updated.
8. **Show it.** The Ledger lists every donation and payout with its PayPal reference. Proof shows the totals adding up. Treasurer shows what the AI decided and why.

A cat's card also has a Save image button that makes a 9:16 picture of the cat.

## Why PayPal

The whole idea is that money moves visibly. Checkout takes donations, Payouts pays the vet, and webhooks tell the app what actually settled. Each payout carries a stable `sender_batch_id`, so a retry can't pay twice. The treasurer is also offered two read-only PayPal agent toolkit tools, `get_order` and `list_transactions`, with personal details removed. `[CONFIRM AFTER LIVE RUN]` The ledger's PayPal reference column lets anyone match a row to a PayPal record.

## How AI and PayPal move money together

The hackathon's theme is "Build What's Next with PayPal and AI", and a project must meaningfully use both. Here each has a job the fund can't run without: the AI decides what should happen next, code decides whether it may happen and how much, and PayPal moves the money.

| Step | What the AI does | What PayPal does |
|---|---|---|
| Donate | Nothing | A neighbour approves in PayPal Checkout. The server captures the order, and a webhook confirms it |
| Choose a cat | Looks at the waiting cats and the fund, calls `fund_next_cat`, writes why | Nothing. The fund sets the money aside in the app's own ledger |
| Pay the deposit | After a vet books, calls `pay_vet_deposit` | If the money gate passes, Payouts sends the vet the deposit. Code sets the amount and the payee |
| Check the proof | Reads the receipt. Code compares it with the booking | Nothing |
| Pay the balance | Calls `release_vet_balance` | After the checks and a caretaker's yes, Payouts sends the balance. A webhook reports the result |

The AI has no tool that takes an amount or a PayPal address, and its PayPal toolkit tools can only read.

## How the AI treasurer is bounded

The AI proposes. Rules check. A person approves.

- **The AI proposes.** It calls a short list of tools by cat id and words. It never chooses an amount or a payee; code supplies both.
- **Rules check.** One function, the money gate, runs every payout. It takes a lock, checks the guardrails from the database, writes the action down, and only then calls PayPal. Guardrails: allow-listed payees, a cap per cat, a cap per day, a verified receipt, a confirmed ear-tip, no duplicate payout.
- **A person approves.** A caretaker confirms the ear-tip photo before the balance. Any payout over the approval threshold waits for a caretaker. A caretaker can also reject or hold.
- **Untrusted input.** Receipts, photos and cat text are data. Text in an image can't authorise anything.
- A daily cap on AI calls limits cost.

At the placeholder prices the deposit is below the approval threshold, so the deposit does not wait for a person. `[CONFIRM: owner decision I6, whether a caretaker approves every deposit]`

## Architecture in brief

```
Browser (Next.js app, camera, PayPal buttons, AG Grid ledger)
   |
Next.js route handlers  <--- PayPal webhooks
   |
Postgres (source of truth)  <-->  Worker: the AI treasurer loop
   |                               money gate: guardrails -> action row -> PayPal
S3: private originals, public scrubbed copies
```

- Next.js, TypeScript, Postgres with Drizzle, a separate worker process.
- Claude on Amazon Bedrock for photo checks, receipt reading and the treasurer. Locally it can run through the `claude` command line instead (see below).
- Cat spotting hint runs in the browser (COCO-SSD through TensorFlow.js); no photo leaves the phone for it.
- AG Grid Community for the ledger. Render for hosting.
- The model is never in the path of a page load.

## Run it locally

You need Node 22 and Postgres 17.

1. Make two databases, `strayfund_dev` and `strayfund_test`.
2. `cp .env.example .env.local` and fill it in. Every variable is explained in `.env.example`. Keep real values out of git; `.env*` is ignored.
3. `npm install`
4. `npm run db:migrate`
5. `SEED_CONFIRM=yes npm run seed` fills the dev database with sample cats and sample money. It empties that database first and refuses unless `DEMO_MODE=true` and PayPal is not live.
6. `npm run dev`, and in a second terminal `npm run worker`.
7. Open `http://localhost:3000`. Check `http://localhost:3000/api/health`.

PayPal sandbox needs `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and a sandbox buyer account to pay with. With `DEMO_MODE=true` a role strip lets you act as neighbour, caretaker or vet.

**Tests.** `npm test` runs the suite against `TEST_DATABASE_URL`. `npm run lint` and `npx tsc --noEmit` check the rest. `npm run e2e` runs one browser test of the main story against fakes, on a scratch database whose name ends in `_e2e` (see the end of `.env.example`).

**The subscription route.** For local work only, set `AI_PROVIDER=claude-cli`. Photo checks and the treasurer then run through `claude -p` on your own Claude login, with no Bedrock calls. The CLI is given no tools and runs in safe mode. Production refuses this setting. Results on this route do not prove Bedrock's model behaves the same.

## Deploy

See [docs/deploy.md](docs/deploy.md): S3 buckets, IAM keys, billing alert, Render Blueprint (`render.yaml`), PayPal webhook, first-boot check, live checks and the "Before real money" list. Nothing in it has been run against a real AWS account yet. `[CONFIRM AFTER LIVE RUN]`

## Test it

Live site: `[LIVE URL]`. Pick Neighbour, Caretaker or Vet in the role strip. Pay with a PayPal sandbox buyer account `[OWNER: add the sandbox buyer login judges should use, or say how to get one]`. The Postman collection is in `docs/postman/`.

## What this is not yet

Read this before you trust it with anything real.

- **No real sign-in.** The Neighbour, Caretaker and Vet roles are simulated and labelled so. Anyone can pick Caretaker. Verified accounts come before any real money.
- **Sandbox money only.** The app refuses to start with demo roles and live PayPal together, and the "test money" wording only shows when PayPal is not live.
- **Demo caretakers see seeded places.** In demo mode the desks hide real coordinates, original photos and the vet's email. A public demo should still never use a real feeding spot.
- **A vet and a caretaker could collude, and a photo could be forged.** The checks make that harder and leave a record; they don't make it impossible. We chose not to build a volunteer audit flow.
- **Photo blurring is the AI's word.** A photo is published automatically when the AI lists regions to blur and says `no_sensitive_content` is true. If the AI lists no regions and says that, nothing is blurred and no person looks. A caretaker can hold any photo.
- **The demo caretaker's tick on a held photo is blind.** In demo mode the caretaker can't see the original, so ticking "nothing sensitive" is a guess.
- **Donors are named by default.** A switch hides your name in thanks and on the ledger. The default is shown.
- **The live camera rule is enforced in the app only.** A custom client could send any photo to the API.
- **The coat rule gives female priority.** Calico and tortoiseshell cats are treated as female, because almost all are. A vet record overrides it. A wrong call moves a cat up the queue.
- **Two neighbours can queue a cat.** Names are free to make, so one person could use two. Without a verified ear-tip photo the balance never releases, but the deposit may already be paid.
- **Refunds and chargebacks are handled in code but not proven on real PayPal.** A refund whose webhook is lost is not polled.
- **Items under "Before real money" in [docs/deploy.md](docs/deploy.md)** are open: MFA and key rotation, TLS-only bucket policies, a separate live PayPal app, payouts stuck at PayPal that need a developer, and more.
- **Not yet verified on real PayPal or Bedrock:** real webhook signatures and payload shapes, a donation captured through the screen, the treasurer on Bedrock, the toolkit's `get_order` through the app and `list_transactions` (it returned 403 on the sandbox app), phone camera over HTTPS, real S3. Sandbox order, capture and payout calls were run once from a script. `[CONFIRM AFTER LIVE RUN]`
- **Cut or later:** adoption fees, foster allowance, monthly sponsors, merging duplicate cats, a map.

## Licence

MIT, see [LICENSE](LICENSE). Dependency and asset licences are in [docs/licences.md](docs/licences.md).
