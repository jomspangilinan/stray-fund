import { defineConfig } from "vitest/config";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";

config({ path: ".env.local", quiet: true });

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    globalSetup: ["tests/helpers/globalSetup.ts"],
    // An empty JUDGE_GATE means no gate, whatever .env.local sets. Gated tests stub JUDGE_GATE="true" and their own code.
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? "", JUDGE_GATE: "" },
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
