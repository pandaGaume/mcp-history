import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));

// Tests run against the sources: no build needed, and every package sees the others' changes at once.
export default defineConfig({
    resolve: {
        alias: [
            { find: /^@cyanmycelium\/mcp-history-recorder$/, replacement: source("mcp-history-recorder/src/index.ts") },
            { find: /^@cyanmycelium\/mcp-history-sqlite$/, replacement: source("mcp-history-sqlite/src/index.ts") },
            { find: "@cyanmycelium/mcp-history/conformance", replacement: source("mcp-history/src/conformance/index.ts") },
            { find: /^@cyanmycelium\/mcp-history$/, replacement: source("mcp-history/src/index.ts") },
        ],
    },
    test: {
        include: ["tests/**/*.test.ts"],
        exclude: ["tests/live/**"],
        environment: "node",
    },
});
