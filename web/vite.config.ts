import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  esbuild: { legalComments: "none" },
  build: {
    modulePreload: false,
    license: { fileName: "THIRD_PARTY_NOTICES.txt" },
  },
});
