import { defineConfig } from "vitest/config";
import path from "node:path";
// The comparison engine's parseInstances() uses the browser DOMParser, so the
// tests run in a jsdom environment that provides DOMParser/window.
export default defineConfig({
  // Mirror tsconfig's "@/*" path alias so tests can import app modules.
  resolve: { alias: { "@": path.resolve(__dirname) } },
  test: {
    environment: "jsdom",
    include: ["**/*.test.ts", "**/*.test.tsx"],
  },
});
