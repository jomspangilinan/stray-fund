import { defineConfig, devices } from "@playwright/test";
import { appEnv, BASE_URL, CAMERA_FIXTURE, PORT } from "./tests/e2e/env";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "*.spec.ts",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    // The invented spot every sighting is taken at. Nothing here is a real place.
    geolocation: { latitude: 10.4321, longitude: 120.8765 },
    permissions: ["camera", "geolocation"],
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Pixel 7"],
        launchOptions: {
          args: [
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
            `--use-file-for-fake-video-capture=${CAMERA_FIXTURE}`,
          ],
        },
      },
    },
  ],
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: BASE_URL,
    env: appEnv(),
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
