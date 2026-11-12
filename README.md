# Stray Fund

DRAFT for the owner to check. Working name; the name lives in one constant, `APP_NAME` in `src/lib/config.ts`.

A shared fund for one neighbourhood's stray cats. Neighbours spot cats, report the ones that look hurt, and donate. People check each report. An AI treasurer weighs what they found and picks which cat gets neutered next. Rules check every payment before it goes out, and a person signs off before any money reaches the vet. Every peso shows on a public ledger.

Built for the PayPal AI Hackathon. It runs on PayPal sandbox money only.

## The problem

Strays multiply when they are fed but not neutered. Neighbours want to help, but they don't know where a donation goes, and the cutest cat gets all the attention. The cat that has waited longest, or is pregnant, or is hurt, gets none.

## How it works

1. **Spot.** A neighbour takes a live camera photo of a cat. Old photos can't be uploaded. On the judges' AI path the AI checks that it is a real cat, matches it to a known cat or makes a new card, and blurs people, signs and plates before anything is public. For everyone else no AI is called: the cat shows in the yard at once and the photo is published with only the cat sharp (see Test it).
2. **Report.** After the photo, a neighbour can say a cat looks hurt, pregnant, sick or like a kitten, and add a note only caretakers see. There is no way to report without a photo taken then. A report is a claim: it holds the cat back from funding at once, and it moves nothing else until a person checks it.
3. **Ear-tip.** The AI does not judge ear-tips; in tests it got them wrong. Neighbours answer Yes, No or Not sure. Two different people saying No queue the cat. A caretaker settles any disagreement.
4. **Donate.** Neighbours give through PayPal Checkout into one shared fund. Fees are counted, so the fund only holds what arrived.
5. **Check.** A caretaker with an ID tag confirms or dismisses each report, and it tops their desk. A confirmed report keeps the cat on hold until a registered vet clears it for surgery, and a caretaker cannot lift it by unticking the flag in Edit details. A dismissed report ends the hold, and that person can't file the same claim on that cat again.
6. **Decide.** The AI treasurer reads the reports, the waiting cats and the fund. It starts from the code's ranking and may go against it, but only by citing a report a person checked, and it must say who goes first and who waits longer because of it. If a report is later dismissed, the move lapses by itself. It is told never to diagnose, and no run in the small local test did, but no code stops it from trying. Keeping the ranking and saying why is as valid an answer as a move.
7. **Pay the deposit.** Rules check the payee, the caps and the fund. If they pass, a caretaker approves the deposit, and then the partner vet gets it through PayPal Payouts.
8. **Prove it.** The vet sends a receipt and a photo of the cat's ear. The AI reads the receipt; code compares it with the booking. A caretaker looks at the photo and taps "I saw the ear-tip".
9. **Pay the balance.** Only after that, the rest is paid. The cat's card is updated.
10. **Show it.** The Ledger lists every donation and payout with its PayPal reference. Proof shows the totals adding up. Treasurer shows what the AI decided and why. Priority lists the cats that are waiting or on hold, in two groups ("Needs a person first", "Next to fund"), with the reason. A cat leaves the list once it is funded. A cat's page tells its story in one timeline: who reported what, who checked it, what the Treasurer decided, each PayPal payment, and the steps still ahead.

A cat's card also has a Save image button that makes a 9:16 picture of the cat.

## Why PayPal

The whole idea is that money moves visibly. Checkout takes donations, Payouts pays the vet, and webhooks tell the app what actually settled. Each payout carries a stable `sender_batch_id`, so a retry can't pay twice. The treasurer is also offered two read-only PayPal agent toolkit tools, `get_order` and `list_transactions`, with personal details removed. Neither has been called through the app yet, and list_transactions returned 403 on the sandbox app. The ledger's PayPal reference column lets anyone match a row to a PayPal record.

## How AI and PayPal move money together

The hackathon's theme is "Build What's Next with PayPal and AI", and a project must meaningfully use both. Here each has a job the fund can't run without: the AI decides what should happen next, code decides whether it may happen and how much, and PayPal moves the money.

| Step | What the AI does | What PayPal does |
|---|---|---|
| Donate | Nothing | A neighbour approves in PayPal Checkout. The server captures the order, and a webhook confirms it |
| A report changes | Reads the reports, may call `set_cat_place` (only citing a report a person checked) or `ask_for_check`, writes the trade-off | Nothing |
| Choose a cat | Looks at the waiting cats and the fund, calls `fund_next_cat`, writes why | Nothing. The fund sets the money aside in the app's own ledger |
| Pay the deposit | After a vet books, calls `pay_vet_deposit` | If the money gate passes, the deposit waits for a caretaker, and then Payouts sends it to the vet. Code sets the amount and the payee |
| Check the proof | Reads the receipt. Code compares it with the booking | Nothing |
| Pay the balance | Calls `release_vet_balance` | After the checks and a caretaker's yes, Payouts sends the balance. A webhook reports the result |

The AI has no tool that takes an amount or a PayPal address, and its PayPal toolkit tools can only read.

## How the AI treasurer is bounded

The AI proposes. Rules check. A person approves.

- **The AI proposes.** It calls a short list of tools by cat id and words. It never chooses an amount or a payee; code supplies both.
- **Rules check.** One function, the money gate, runs every payout. It takes a lock, checks the guardrails from the database, writes the action down, and only then calls PayPal. Guardrails: allow-listed payees, a cap per cat, a cap per day, a verified receipt, a confirmed ear-tip, no duplicate payout.
- **A person approves.** A caretaker confirms the ear-tip photo before the balance. Every deposit waits for a caretaker, whatever its amount, and a balance over the approval threshold waits too. A caretaker can also reject or hold.
- **Standing limits what a report can do.** A neighbour's report can hold a cat, never reorder the list. Code, not the AI, enforces this. `fund_next_cat` refuses a cat on hold. It also refuses (`WEIGHING_NOT_SHOWN`) unless the reason names every other waiting cat that has a confirmed report, or a report a vet cleared in the last 30 days. The rule applies only when such a cat is waiting and can be funded, and the cat being funded has no checked report of its own. It cannot check that what the reason says about the report is true. `set_cat_place` refuses a cat that is not waiting or is on hold, a cited report that is not confirmed or vet-cleared, and a move against the ranking unless a checked report covers every pair it reverses. A move that follows the ranking needs no report. After a cat is funded, a new report only warns staff on the desk, the deposit card and the vet's booking; the balance can still release.
- **Public text is filtered.** Note text, reporter names and exact places are never public. The Treasurer's reasons pass the same filter as cat bios and are replaced by a fixed line if they repeat four words in a row from any note.
- **Untrusted input.** Receipts, photos, notes and cat text are data. Text in an image can't authorise anything.
- A daily cap on AI calls limits cost.

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
5. `SEED_CONFIRM=yes npm run seed` fills the dev database with the seven demo cats and no money. It empties that database first and refuses unless `DEMO_MODE=true` and PayPal is not live.
6. `npm run dev`, and in a second terminal `npm run worker`.
7. Open `http://localhost:3000`. Check `http://localhost:3000/api/health`.

PayPal sandbox needs `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and a sandbox buyer account to pay with. With `DEMO_MODE=true` a role strip lets you act as neighbour, caretaker or vet.

**Demo data.** The seed writes seven real strays, photographed by the project's owner, each with its own photo: Kislap and Milo wait for funding, and Leo, Oliver, Lily, Oreo and Teddy are only spotted. There is no money: Proof starts at ₱0 and the ledger is empty, so every row on it is a real sandbox transaction made in the demo, and nothing is funded until donations cover a ₱1,500 care package after PayPal's fees. One neighbour's open hurt report holds Milo under "Needs a person first", so the waiting list has Kislap first. The report's note is invented, flagged `sample`, and comes with a drawn stand-in photo. It writes no Treasurer decision: confirm Milo's report as the caretaker, clear him as the vet, donate, and the real Treasurer weighs it.

**Tests.** `npm test` runs the suite (1,936 tests) against `TEST_DATABASE_URL`. `npm run lint` and `npx tsc --noEmit` check the rest. `npm run e2e` runs one browser test of the whole story against fakes (about a minute): a hurt report with the camera photo, the desk showing it first, a caretaker confirming, the fund refusing the cat, a vet clearing it, funding, the timeline, and no note text or coordinates on any public page. It uses a scratch database whose name ends in `_e2e`, passed as `E2E_DATABASE_URL` (see the end of `.env.example`). `npx tsx scripts/check-public-leaks.ts` fetches the public pages, `/priority`, `/api/priority`, a cat page with a timeline and the staff desks as a visitor and as each demo role, with a note holding a phone number, a street and a name; see its header for how to run it.

**The subscription route.** For local work only, set `AI_PROVIDER=claude-cli`. Photo checks and the treasurer then run through `claude -p` on your own Claude login, with no Bedrock calls. The CLI is given no tools and runs in safe mode. Production refuses this setting. Results on this route do not prove Bedrock's model behaves the same.

## Deploy

See [docs/deploy.md](docs/deploy.md): S3 buckets, an IAM role through Render's OIDC sign-in (no AWS keys), billing alert, Render Blueprint (`render.yaml`), PayPal webhook, first-boot check, live checks and the "Before real money" list. Nothing in it has been run against a real AWS account yet.

## Test it

Live at https://stray-fund.onrender.com (PayPal sandbox, test money). Judges open the private link `/judge?code=…` once; the code is in the private notes on Devpost. It sets a cookie that lasts until 2026-12-16 and unlocks the full app: the Caretaker and Vet roles, donating and capturing a donation, reports and the cat votes. Without the cookie a visitor can browse every public page, sign in as a Neighbour and spot a cat; the staff roles, donating, reports and votes answer "Open to judges during the hackathon."

The gate is one switch. `JUDGE_GATE` set to exactly `true` turns it on (with `JUDGE_PASSCODE`); anything else means no gate, so local runs, tests and e2e see the full app.

**Spotting without AI.** This applies when `JUDGE_GATE=true`: a visitor without the judge cookie spots without AI. With the gate off everyone counts as a judge and gets the AI path. On this path the photo never calls the AI. The cat shows up in the yard at once with a "Yours" tag, and the photo is published with only the cat sharp and the rest blurred: the phone's own cut-out (YOLO11n-seg on onnxruntime-web) when it can, otherwise the worker develops it (YOLO on onnxruntime-node), usually within a few minutes of upload (the worker waits 60 seconds for the phone, then picks it up on its next tick), with a soft circle on the box and then the middle circle as fallbacks. Limits are 5 photos per account per day and 50 new public cats per day site-wide. `CAT_FINDER=off` on the worker switches the model off. A caretaker can rotate a photo that came out sideways or hold it back, and can remove a cat that a plain photo made by mistake, as long as nothing else (a report, money, a vet record) refers to it.

Locally, run it as above and pick Neighbour, Caretaker or Vet in the role strip. The Postman collection is in docs/postman/.

## What this is not yet

Read this before you trust it with anything real.

- **No real sign-in.** The Neighbour, Caretaker and Vet roles are simulated and labelled so. Anyone can pick Caretaker. Verified accounts come before any real money.
- **Volunteer ID tags and the vet register are simulated.** The demo roles carry a verified badge with a tag number, but no volunteer process, ID check or vet register stands behind it. In the demo anyone can confirm a report or clear a cat.
- **The Treasurer's weighing is lightly tested, and its public words are not guaranteed.** When a cat with a checked report is waiting and the cat being funded has none, code makes the funding reason name that cat. It cannot make the Treasurer fund, and a reason that quotes a note shows as a fixed line. In the last six local runs (weigh 3, hostile 3) the weighing reached a public reason in 1 of 3 weigh runs, and the model said a tool failed that it never called in 1 of 6 runs (8 of 45 valid runs over three rounds). See the eval below. It was tried on the local `claude -p` route on a handful of cases, three runs each, never on Bedrock. See `.superpowers/sdd/2026-11-04-ai-priority-list/prompt-eval.md` for what held and what didn't.
- **A report can delay a cat once.** A false report holds a cat until a caretaker looks, and the reporter can't repeat it. A report counts as checked at once only when a caretaker files it through Edit details. A caretaker or vet who reports from the photo screen files an ordinary open report, like a neighbour.
- **The public filter for the Treasurer's reasons is simple.** It catches digits, place words, stray capitals and four words copied from a note. It misses a name or place written in lowercase and a number spelled out in words. Peso amounts, day counts and the words PayPal and Treasurer are let through on purpose. On the demo desk the Treasurer's payout reasons and review requests are hidden whole instead of filtered.
- **Sandbox money only.** The app refuses to start with demo roles and live PayPal together, and the "test money" wording only shows when PayPal is not live.
- **Demo caretakers see seeded places.** In demo mode the desks hide real coordinates, original photos and the vet's email. A public demo should still never use a real feeding spot.
- **A vet and a caretaker could collude, and a photo could be forged.** The checks make that harder and leave a record; they don't make it impossible. We chose not to build a volunteer audit flow.
- **On the judges' AI path, a photo with a cat goes public with no person looking.** Everything but the area around the cat is blurred: the phone's cut-out when it ran, otherwise a soft circle around the camera's box, later swapped for the server's cut-out when it finds the cat. The box and cut-out come from the phone, so a custom client can widen the sharp area; a box over half the photo is ignored and the middle circle is used instead. The regions the AI lists are blurred again, even inside that area, but anything the AI missed inside it stays sharp. A caretaker can hold any photo.
- **The demo caretaker's tick on a held photo is blind.** In demo mode the caretaker can't see the original, so ticking "nothing sensitive" is a guess.
- **Donors are named by default.** A switch hides your name in thanks and on the ledger. The default is shown.
- **The live camera rule is enforced in the app only.** A custom client could send any photo to the API.
- **The coat rule gives female priority.** Calico and tortoiseshell cats are treated as female, because almost all are. A vet record overrides it. A wrong call moves a cat up the queue.
- **Two neighbours can queue a cat.** Names are free to make, so one person could use two. Without a verified ear-tip photo the balance never releases, but the deposit may already be paid.
- **Refunds and chargebacks are handled in code but not proven on real PayPal.** A refund whose webhook is lost is not polled.
- **Items under "Before real money" in [docs/deploy.md](docs/deploy.md)** are open: MFA and key rotation, TLS-only bucket policies, a separate live PayPal app, payouts stuck at PayPal that need a developer, and more.
- **Not yet verified on real PayPal or Bedrock:** real webhook signatures and payload shapes, a donation captured through the screen, the treasurer on Bedrock, the toolkit's `get_order` through the app and `list_transactions` (it returned 403 on the sandbox app), phone camera over HTTPS, real S3. Sandbox order, capture and payout calls were run once from a script.
- **Cut or later:** adoption fees, foster allowance, monthly sponsors, merging duplicate cats, a map.

## Licence

AGPL-3.0, see [LICENSE](LICENSE). Dependency and asset licences are in [docs/licences.md](docs/licences.md).

**Model.** The worker finds the cat in a photo with Ultralytics YOLO11n-seg (AGPL-3.0), exported to ONNX at `public/models/cat-seg-v1/yolo11n-seg.onnx`. Its licence is why this repo is AGPL-3.0 rather than MIT.
