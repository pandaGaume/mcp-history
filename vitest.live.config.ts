import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));
// The live tests drive the real SCADA chain from a sibling mcp-scada checkout: its service, its Modbus
// provider, and its test bench (pyModbusTCP simulator and C++ mcp-modbus provider). MCP_SCADA_DIR overrides it.
const scada = process.env.MCP_SCADA_DIR ?? fileURLToPath(new URL("../mcp-scada", import.meta.url));

export default defineConfig({
    resolve: {
        alias: [
            { find: /^@mcp-scada\/(.*)$/, replacement: `${scada.replace(/\\/g, "/")}/$1` },
            { find: /^@cyanmycelium\/mcp-history-recorder$/, replacement: source("mcp-history-recorder/src/index.ts") },
            { find: /^@cyanmycelium\/mcp-history-sqlite$/, replacement: source("mcp-history-sqlite/src/index.ts") },
            { find: "@cyanmycelium/mcp-history/conformance", replacement: source("mcp-history/src/conformance/index.ts") },
            { find: /^@cyanmycelium\/mcp-history$/, replacement: source("mcp-history/src/index.ts") },
        ],
        // One copy of each MCP package for both sides of the chain: mcp-scada's sources would otherwise load their own.
        dedupe: ["@cyanmycelium/mcp-core", "@cyanmycelium/mcp-broker", "@cyanmycelium/mcp-broker-provider", "@cyanmycelium/mcp-uns"],
    },
    test: {
        include: ["tests/live/**/*.test.ts"],
        environment: "node",
        testTimeout: 60_000,
        hookTimeout: 90_000,
        fileParallelism: false,
    },
});
