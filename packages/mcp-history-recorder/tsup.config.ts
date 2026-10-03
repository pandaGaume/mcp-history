import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
    platform: "node",
    external: ["@cyanmycelium/mcp-history", "@cyanmycelium/mcp-uns", "better-sqlite3"],
});
