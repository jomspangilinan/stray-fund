# Stray Fund

[![Live demo](https://img.shields.io/badge/live%20demo-stray--fund.onrender.com-0b6b4f)](https://stray-fund.onrender.com)
[![PayPal sandbox](https://img.shields.io/badge/PayPal-sandbox%20only-003087)](https://developer.paypal.com/tools/sandbox/)
[![Licence: AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-blue)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org)
[![Claude](https://img.shields.io/badge/AI-Claude%20on%20Bedrock-d4a27f)](https://aws.amazon.com/bedrock/claude/)

Neighbours fund spay and neuter for the stray cats on their street. An AI treasurer decides which cat is helped next, says why, and pays the vet through PayPal, inside rules that code enforces, with every peso on a public ledger.

<p align="center"><img src="screenshots/card-01-hero.jpg" width="820" alt="Stray Fund: neighbours fund spay and neuter for stray cats. An AI treasurer picks the next cat and PayPal pays the vet, with every peso on a public ledger."></p>

## Highlights

- Every donation and every vet payment sits on a public ledger with its PayPal reference, and the totals add up to the peso.
- An AI treasurer moves the money: it sets money aside for the next cat, sends the vet's deposit and pays the balance, and explains each choice in public.
- It moves money only inside rules. Its tools take a cat id and a reason, never an amount or a payee, and a caretaker approves every deposit, with 5 seconds to undo.
- Caretakers and vets get their own desks: report checks and payments come as swipe cards, each with what the AI read.
- It runs live on the PayPal sandbox, with Claude on Amazon Bedrock as the treasurer.

## Overview

Strays multiply when people feed them but nobody neuters them. Neighbours would chip in, but they can't see where the money goes, and help tends to reach the cutest cat instead of the pregnant or hurt one. Stray Fund keeps the whole trail in public: who reported a cat, who checked it, why the treasurer chose it, and the PayPal reference for every payment.

Stray Fund is built for one barangay's neighbours, the volunteer caretakers who check on the cats, and the partner vet who does the surgery. It was made by [@jomspangilinan](https://github.com/jomspangilinan) as a solo entry to the PayPal AI Hackathon in November 2026. The code is open source under AGPL-3.0, so you can run your own copy for your street, as long as you share your changes.

## Try it

- Open https://stray-fund.onrender.com. Judges get a private link in the Devpost notes that unlocks the Caretaker and Vet roles, donating and reports.
- Follow the [testing guide](testing-guide.pdf): eight steps with screenshots, from spotting a cat to following the money.
- Pay with a PayPal sandbox buyer account. It's test money only.



## How it works

1. A neighbour spots a cat with the phone's live camera. Old photos can't be uploaded.
2. They can report it as hurt, pregnant, sick or a kitten, with a note only caretakers read. A report holds the cat back from funding until a person checks it.
3. Neighbours donate through PayPal Checkout into one shared fund. PayPal's fee is counted, so the fund only holds what arrived.
4. A caretaker confirms or dismisses each report. A confirmed report keeps the cat on hold until a vet clears it for surgery.
5. The AI treasurer reads the waiting cats, the checked reports and the fund, picks the next cat and writes a public reason.
6. Once a vet books the cat, the treasurer asks to pay the deposit. Rules check it, a caretaker approves it, and PayPal Payouts sends it to the partner vet.
7. After surgery the vet sends a receipt and an ear-tip photo. The AI reads the receipt, code compares it with the booking, and a caretaker confirms the ear-tip. Then the treasurer pays the balance through Payouts. A balance over ₱2,000 waits for a person's approval too.

People decide ear-tips, because the AI got them wrong on real photos. Neighbours answer Yes, No or Not sure, two different people saying No queue the cat, and a caretaker settles any disagreement.

<p align="center">
  <img src="screenshots/card-02-yard.jpg" width="400" alt="The yard: every stray on the street in one place, each with its own card and story">
  <img src="screenshots/card-08-spot.jpg" width="400" alt="Spotting: a live camera photo, the new cat's card, and a sick report with a note for caretakers">
</p>

Four public pages show the money. Priority lists who's next and why, Treasurer lists every AI decision with its reason, Ledger lists every donation and payout with its PayPal reference, and Proof shows the totals adding up exactly. Each cat's page tells its story as one timeline.

<p align="center">
  <img src="screenshots/card-03-treasurer.jpg" width="400" alt="Who's next, and why, is public: the Priority and Treasurer pages">
  <img src="screenshots/card-04-ledger.jpg" width="400" alt="Every peso in the open: the Ledger and Proof, with PayPal references">
</p>

## The desks

Caretakers and vets work on their own screens, on a green bar, apart from the neighbour app. The caretaker's To check is a stack of cards. Each card says what Claude read and which way it leans; a swipe right or left decides, and nothing is sent for 5 seconds, so Undo can take it back. Cats is a profile per cat with one Save, where a confirmed or dismissed report can be reopened if someone got it wrong. The vet gets To do and Bookings, with each cat's photo. A vet's clearance and money PayPal has sent can't be undone.

<p align="center">
  <img src="screenshots/cat-profile.jpg" width="190" alt="A cat's profile on the caretaker desk: name, sex, ear-tip and stage, with one Save">
  <img src="screenshots/vet-to-do.jpg" width="190" alt="The vet's To do: a cat to clear for surgery and a booking waiting for evidence">
  <img src="screenshots/priority.jpg" width="190" alt="Priority: cats needing a person first, then the order the treasurer will fund them">
</p>

## Trusting the AI with money

The hackathon asks for AI behind the wheel, and here it is: the treasurer sets money aside (`fund_next_cat`), sends the vet's deposit (`pay_vet_deposit`) and pays the balance (`release_vet_balance`), all through PayPal Payouts. It drives inside rules that code enforces.

<p align="center"><img src="screenshots/card-07-money.jpg" width="640" alt="The AI moves the money, inside the rules: the treasurer picks the cat and pays the vet, code sets the amount and the payee, and the money gate checks every payout"></p>

- Its tools take a cat id and a reason, never an amount or a payee ([src/server/agent/tools.ts](src/server/agent/tools.ts)). Code works out the amount and pays only the registered vet.
- Every payout goes through one function, the money gate ([src/server/moneyGate.ts](src/server/moneyGate.ts)). It takes a lock, checks the guardrails ([src/server/guardrails.ts](src/server/guardrails.ts)), writes the action down, and only then calls PayPal. The guardrails cover allow-listed payees, caps per cat and per day, only money already set aside, a verified receipt, a confirmed ear-tip and duplicate payouts.
- A caretaker approves every deposit. A balance of up to ₱2,000 goes out on the treasurer's call once the receipt is verified and a caretaker has confirmed the ear-tip; a bigger one waits for a person.
- A neighbour's report can hold a cat but never reorder the list. To pass over a cat, the treasurer has to cite a report a person checked, and its reason has to name the cats it passed over. Code enforces both, though it can't check that what the reason says is true.
- Notes, receipts and photos are data. Text inside an image can't authorise anything, and a reason that repeats four words from a note is swapped for a fixed line before it goes public.
- A daily cap limits AI calls.

## PayPal

Checkout (Orders v2) takes donations and records each capture's net amount after fees. Payouts pays the vet a deposit and later a balance, and each payout reuses one `sender_batch_id`, so a retry can't pay twice. Webhooks settle captures and payouts. The treasurer is also offered the PayPal agent toolkit's read-only `get_order`, though it hasn't called it through the app yet. The code is in [src/server/paypal/](src/server/paypal/).

On the live sandbox site on Nov 13, a caretaker's approval sent the first vet deposit: ₱450 for Kislap, PayPal reference `YUZVTFYR5MKWS`, reported succeeded.

<p align="center"><img src="screenshots/card-09-paypal.jpg" width="640" alt="Money in through Checkout, out through Payouts: a ₱1,600 donation and the ₱450 deposit waiting for a caretaker"></p>

## AI

Claude is the treasurer. On the live site it runs as Claude Haiku 4.5 on Amazon Bedrock, where it funded its first cat on Nov 12 after sandbox donations. Locally it can run through the Claude command line instead (`AI_PROVIDER=claude-cli`, local only; production refuses it). Claude also reads vet receipts, and on the judges' path it checks spot photos and marks regions to blur.

Ultralytics YOLO11n-seg cuts the cat out of a photo so only the cat stays sharp, on the phone with onnxruntime-web or in the worker. COCO-SSD runs in the browser for the "cat found" hint, so no photo leaves the phone for that.

## Architecture

```
Browser (Next.js app, camera, PayPal buttons, AG Grid ledger)
   |
Next.js route handlers  <--- PayPal webhooks
   |
Postgres (source of truth)  <-->  Worker: the AI treasurer loop
   |                               money gate: guardrails -> action row -> PayPal
S3: private originals, public scrubbed copies
```

Next.js and TypeScript, Postgres with Drizzle, and a separate worker process, hosted on Render. The model is never in the path of a page load.

## Known limits

Read this before trusting it with anything real.

- There's no real sign-in. The roles, volunteer ID tags and the vet register are simulated, so anyone in the demo can confirm a report or clear a cat.
- The treasurer's weighing was tried on a handful of cases, three runs each, on the local `claude -p` route and not yet on Bedrock. It sometimes funded nobody, and in 8 of 45 valid runs it said a tool failed when it never called one.
- The filter on the treasurer's public reasons is simple. It misses a name or place written in lowercase and numbers spelled out in words.
- On the judges' path a spot photo goes public with no person looking. Everything but the cat is blurred, and a caretaker can hold it back afterwards.
- A vet and a caretaker could collude, a photo could be forged, and the live-camera rule is enforced in the app only.
- The coat rule treats calico and tortoiseshell cats as female, so a wrong call moves a cat up the queue.
- Refunds and chargebacks are handled in code but not proven on real PayPal, and live webhook deliveries haven't been checked end to end.
- Not built yet: adoption fees, foster allowance, monthly sponsors, a map. Merging duplicate cats works only for a duplicate made by a plain photo.

## Roadmap

Next, in rough order:

- Verified accounts for neighbours, caretakers and vets before any real money moves.
- Live PayPal webhook deliveries checked end to end, and the treasurer's hostile-note tests re-run on Bedrock.
- A feeding station that logs each meal by itself. The app already takes meal logs and shows "Meals given" on Proof; the station isn't built.
- Other barangays running their own fund, each with its own yard.
- Adoption fees flowing back into the fund, and monthly sponsors.

## Development

### Run it locally

You need Node 22 and Postgres 17.

1. Make two databases, `strayfund_dev` and `strayfund_test`.
2. `cp .env.example .env.local` and fill it in. `.env.example` explains every variable, and `.env*` is ignored by git.
3. `npm install`, then `npm run db:migrate`.
4. `SEED_CONFIRM=yes npm run seed` loads seven real strays with their own photos and no money. It empties the dev database first and refuses unless `DEMO_MODE=true` and PayPal isn't live.
5. `npm run dev`, and `npm run worker` in a second terminal.
6. Open http://localhost:3000. The strip at the top switches between Neighbour, Caretaker and Vet.

PayPal sandbox needs `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and a sandbox buyer account. The seed holds Milo back with one sample hurt report, so the quickest tour is: confirm Milo's report as Caretaker, clear him as Vet, donate ₱1,600 (enough to cover the ₱1,500 care package after PayPal's fee), then open Priority and Treasurer.

### Tests

`npm test` runs 1,947 tests against a real Postgres in `TEST_DATABASE_URL`. `npm run lint` and `npx tsc --noEmit` check the rest. `npm run e2e` walks the whole story in a browser against fakes, from a hurt report to a funded cat, and checks that no note or coordinates reach a public page; it needs a scratch database in `E2E_DATABASE_URL`. `npx tsx scripts/check-public-leaks.ts` loads the public pages and the staff desks as each role, with a note holding a phone number, a street and a name.

### Deploy

[docs/deploy.md](docs/deploy.md) covers the Render Blueprint (`render.yaml`), S3, an IAM role through Render's OIDC sign-in with no AWS keys, the PayPal webhook, and the "Before real money" checklist. The live site was deployed by following it. Its Postgres refuses outside connections, and an AWS budget of $5 a month emails at 80% and 100%.

On the live site these have run for real: spot photos stored in S3 from a phone camera over HTTPS, a donation captured through the screen, the treasurer on Bedrock funding a cat and asking a caretaker to check a report, and the ₱450 Payouts deposit.

Two switches matter for a public demo. `JUDGE_GATE=true` with `JUDGE_PASSCODE` limits the staff roles, donating, reports and votes to judges, who open `/judge?code=…` once; everyone else can browse and spot as a Neighbour, with a daily limit and no AI. The live site runs with the gate on. `DEMO_HIDE_PRIVATE=true` hides original photos, receipt text, the treasurer's reasons and the vets' emails on the demo desks. Exact places stay hidden in demo mode either way, because they're real GPS points.

## Feedback

Found a bug or have an idea? Open an [issue](https://github.com/jomspangilinan/stray-fund/issues). If you run a fund like this for your own street, I'd like to hear how it goes.

## Licence

AGPL-3.0, see [LICENSE](LICENSE). Dependency and asset licences are in [docs/licences.md](docs/licences.md). The worker finds the cat in a photo with Ultralytics YOLO11n-seg (AGPL-3.0), exported to ONNX at `public/models/cat-seg-v1/yolo11n-seg.onnx`, which is why this repo is AGPL-3.0 rather than MIT.
