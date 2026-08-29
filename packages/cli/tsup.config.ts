import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  splitting: false,
  noExternal: [
    /^@vibe-replay\/provider/,
    "@vibe-replay/providers-default",
    "@vibe-replay/replay-core",
  ],
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
