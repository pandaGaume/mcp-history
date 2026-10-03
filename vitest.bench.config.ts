import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));

// Load measurements, run on demand with `npm run bench:append`: not part of `npm test`.
export default defineConfig({
    resolve: {
        alias: [
            { find: /^@cyanmycelium\/mcp-history-sqlite$/, replacement: source("mcp-history-sqlite/src/index.ts") },
            { find: /^@cyanmycelium\/mcp-history$/, replacement: source("mcp-history/src/index.ts") },
        ],
    },
    test: {
        include: ["bench/**/*.bench.ts"],
        environment: "node",
        testTimeout: 900_000,
        hookTimeout: 90_000,
    },
});
