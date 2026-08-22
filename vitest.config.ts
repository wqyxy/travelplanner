import { defineConfig } from "vitest/config";

export default defineConfig({
  ssr: { external: ["node:sqlite"] },
  test: { environment: "node", include: ["apps/{server,web}/**/*.test.ts"], server: { deps: { external: ["node:sqlite"] } } }
});
