// Copies onnxruntime-web's runtime files into public/ort, so the phone loads them from this site and never from a CDN.
// Runs after npm install. public/ort is generated and ignored by git.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

const from = "node_modules/onnxruntime-web/dist";
if (!existsSync(from)) process.exit(0);
mkdirSync("public/ort", { recursive: true });
for (const f of [
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
]) {
  copyFileSync(`${from}/${f}`, `public/ort/${f}`);
}
