# Licence check

DRAFT for the owner to check. Read from `node_modules/*/package.json` on 2026-11-04 (installed versions), the repo's tracked files, and the code that loads assets. This is a reading of the licence fields, not legal advice.

## Verdict

Nothing blocks a public MIT repo. Three things need a look from the owner:

1. The cat detector model files have no recorded source. See "Assets".
2. `sharp` pulls in LGPL-3.0 native libraries (libvips). Fine for use as a dependency; the libraries are not copied into this repo.
3. `src/app/favicon.ico` looks like the create-next-app default and has no recorded source.

The repo already has a `LICENSE` (MIT, 2026, John Jomel Pangilinan). Keep it unless you want a different one.

## Direct dependencies

| Package | Version | Licence |
| --- | --- | --- |
| @anthropic-ai/bedrock-sdk | 0.36.0 | MIT |
| @anthropic-ai/sdk | 0.137.0 | MIT |
| @aws-sdk/client-s3 | 3.1161.0 | Apache-2.0 |
| @paypal/agent-toolkit | 1.11.0 | ISC |
| @paypal/paypal-server-sdk | 1.1.0 | MIT |
| @paypal/react-paypal-js | 10.6.1 | Apache-2.0 |
| @tensorflow-models/coco-ssd | 2.2.3 | Apache-2.0 |
| @tensorflow/tfjs-backend-cpu | 4.22.0 | Apache-2.0 |
| @tensorflow/tfjs-backend-webgl | 4.22.0 | Apache-2.0 |
| @tensorflow/tfjs-converter | 4.22.0 | Apache-2.0 |
| @tensorflow/tfjs-core | 4.22.0 | Apache-2.0 |
| ag-grid-community | 36.2.0 | MIT |
| ag-grid-react | 36.2.0 | MIT |
| dotenv | 18.0.9 | BSD-2-Clause |
| drizzle-orm | 0.45.4 | Apache-2.0 |
| jose | 6.2.15 | MIT |
| next | 16.4.4 | MIT |
| pg | 8.23.1 | MIT |
| react | 19.3.0 | MIT |
| react-dom | 19.3.0 | MIT |
| sharp | 0.35.5 | Apache-2.0 |
| tsx | 4.23.15 | MIT |
| zod | 3.25.76 | MIT |

Dev dependencies (not shipped): @playwright/test Apache-2.0; @tailwindcss/turbopack, tailwindcss, drizzle-kit, eslint, eslint-config-next, vitest, @types/* MIT; typescript Apache-2.0.

## Flags

| Item | Licence | Why it matters | Action |
| --- | --- | --- | --- |
| @img/sharp-libvips-darwin-arm64 (via sharp) | LGPL-3.0-or-later | LGPL native library. Installed as a binary, dynamically linked, not copied into this repo. | None for a hackathon. Keep sharp as a normal dependency, do not vendor the library. |
| @img/sharp-wasm32 (via sharp, optional) | Apache-2.0 AND LGPL-3.0-or-later AND MIT | Same libvips. | Same. |
| lightningcss (via Tailwind), axe-core | MPL-2.0 | File-level copyleft. Build and test tools, unmodified. | None. |
| caniuse-lite | CC-BY-4.0 | Data, needs credit. Build-time only, not shipped to users. | None. |
| argparse | Python-2.0 | Permissive. | None. |
| ag-grid-community | MIT | Only the free Community edition is imported (`ag-grid-community`, `ag-grid-react`). No enterprise package, no licence key. | Keep it that way. Enterprise features need a paid licence. |

Everything else installed (about 760 packages including transitive, as installed on this Mac; binaries for other systems were not scanned) is MIT, Apache-2.0, ISC, BSD, 0BSD, BlueOak, CC0 or Unlicense. No GPL or AGPL anywhere in `node_modules`.

PayPal packages are used under their own open source licences; this does not grant use of the PayPal name or logo beyond what the hackathon allows.

## Assets

| Asset | Where | Licence / source | Status |
| --- | --- | --- | --- |
| Cat detector model, 6 files (`model.json`, 5 weight shards, about 18 MB) | `public/models/cat-detector-v1/` | The loader is `@tensorflow-models/coco-ssd` with base `lite_mobilenet_v2` (SSDLite MobileNet v2 trained on COCO). The package is Apache-2.0. The weights were copied from the model's public Google-hosted location (the package's default URL is under `storage.googleapis.com/tfjs-models`). | Source not recorded in the repo. Owner to confirm where the files came from and keep a note. Weights of that model are published for reuse, but COCO's images carry their own Flickr terms and its annotations are CC BY 4.0. Credit COCO and TensorFlow.js in the Devpost text. |
| Gabarito font | `next/font/google` in `src/app/layout.tsx`, files fetched at build and served from this site | SIL Open Font License 1.1 (as listed on Google Fonts; owner to confirm on the font's page). | OK to use and serve. No font file is committed. |
| App icon | `public/icon.svg` | Drawn for this project (simple shapes in the file). | Fine. |
| Favicon | `src/app/favicon.ico` | Not drawn by us as far as the history shows; it came with the first commit and matches the Next.js starter. | Owner to confirm. Replace with `public/icon.svg` converted if unsure. |
| Cat look-alike avatars, keepsake picture, yard scene | `src/lib/avatar.ts`, `courtyard.ts`, `keepsake*.ts` | Generated in code from fixed tables. | Ours. |
| Cat and receipt photos | Not in the repo | `tests/fixtures/vision/` is gitignored; `.data/` is ignored. | Check `git ls-files` again before making the repo public. |
| Music, stock images, third-party logos | None in the repo | The video may add music; use only royalty-free tracks you can credit. | Owner. |

## Suggestion: LICENSE

The existing MIT `LICENSE` is fine for this project and for Devpost's open source requirement. If you want a different one, replace the file; do not add a second.
