import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, it } from "vitest";
import { startTestBroker, type ITestBroker } from "@cyanmycelium/mcp-broker/testing";
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";
import { McpClient, McpServerBuilder, type IMcpServer } from "@cyanmycelium/mcp-core";
import { StreamableHttpTransport } from "@cyanmycelium/mcp-core/node";
import { BrokerAccessGuard } from "@cyanmycelium/mcp-uns";
import { HistoryBehavior, HistorySlotStore, buildHistoryDeclaration, type IHistorySample } from "@cyanmycelium/mcp-history";
import { SqliteHistoryStore } from "@cyanmycelium/mcp-history-sqlite";

/**
 * How fast samples reach the history, by batch size and number of writers:
 *
 *   direct:  SqliteHistoryStore.appendAsync, in process (the store's ceiling)
 *   slot:    client ─► broker ─► history slot ─► SqliteHistoryStore (the recorder's path)
 *
 * Run with `npm run bench:append`; BENCH_SECONDS sets the duration of a cell (default 3).
 */

const NAMESPACE = "uns://production/site1";
const IDS = Array.from({ length: 100 }, (_, index) => `${NAMESPACE}/line1/tag${String(index).padStart(3, "0")}/value`);
const SECONDS = Number(process.env.BENCH_SECONDS ?? 3);
const BATCHES = (process.env.BENCH_BATCHES ?? "1,10,100,1000,10000").split(",").map(Number);
const WRITERS = (process.env.BENCH_WRITERS ?? "1,4,16").split(",").map(Number);

const dir = mkdtempSync(join(tmpdir(), "mcp-history-bench-"));
const rows: string[] = [];
let broker: ITestBroker;
let slotStore: SqliteHistoryStore;
let slotTransport: DirectTransport;
let slotServer: IMcpServer;
const clients: McpClient[] = [];

/** Strictly increasing timestamps across every writer: no sample is a duplicate. */
let clock = Date.parse("2026-01-01T00:00:00.000Z");
function batch(size: number): IHistorySample[] {
    const samples: IHistorySample[] = [];
    for (let index = 0; index < size; index++) {
        const at = new Date(clock++).toISOString();
        samples.push({ id: IDS[index % IDS.length]!, value: Math.random() * 100, quality: "good", sourceTimestamp: at, receivedTimestamp: at, provider: "bench" });
    }
    return samples;
}

interface ICell {
    samples: number;
    calls: number;
    errors: number;
    latencies: number[];
}

/** `writers` loops appending `size`-sample batches back to back for SECONDS. */
async function measure(label: string, writers: number, size: number, append: (samples: IHistorySample[]) => Promise<{ accepted: number }>): Promise<void> {
    const cell: ICell = { samples: 0, calls: 0, errors: 0, latencies: [] };
    const deadline = performance.now() + SECONDS * 1000;
    let firstError = "";
    await Promise.all(
        Array.from({ length: writers }, async () => {
            while (performance.now() < deadline) {
                const samples = batch(size);
                const started = performance.now();
                try {
                    const result = await append(samples);
                    cell.samples += result.accepted;
                } catch (error) {
                    cell.errors++;
                    firstError ||= error instanceof Error ? error.message : String(error);
                }
                cell.latencies.push(performance.now() - started);
                cell.calls++;
            }
        })
    );
    const sorted = [...cell.latencies].sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!.toFixed(1) : "-");
    const row = `| ${label} | ${writers} | ${size} | ${(cell.samples / SECONDS).toFixed(0)} | ${(cell.calls / SECONDS).toFixed(0)} | ${pct(50)} | ${pct(95)} | ${cell.errors} |`;
    rows.push(row);
    console.log(row + (firstError ? ` first error: ${firstError.slice(0, 160)}` : ""));
}

beforeAll(async () => {
    broker = await startTestBroker({
        callers: { recorder: { service: "history-recorder" } },
        providers: { "mcp-history": { subjects: ["service:mcp-history"], allowedResources: ["/production/site1/**"] } },
        policy: {
            slotResources: { history: "/production/site1/history" },
            roles: {
                caller: { capabilities: ["mcp.tools.call", "mcp.tools.list", "mcp.resources.read"] },
                recorder: { inherits: ["caller"], capabilities: ["history.record", "history.read"] },
            },
            assignments: [{ id: "recorder-site", subject: "service:history-recorder", role: "recorder", resource: "/production/site1/**" }],
        },
    });
    slotStore = new SqliteHistoryStore({ path: join(dir, "slot.db") });
    slotTransport = new DirectTransport(broker.providerUrl("history"), { secret: broker.providerSecret("mcp-history") });
    slotServer = new McpServerBuilder()
        .withName("history")
        .withTransport(slotTransport)
        .register(new HistoryBehavior(slotStore, new BrokerAccessGuard(slotTransport.broker), { payload: "structured" }))
        .build();
    await slotServer.start();
    for (let attempt = 0; ; attempt++) {
        try {
            await slotTransport.broker.declare(buildHistoryDeclaration({ version: "bench-1", namespace: NAMESPACE }));
            break;
        } catch (error) {
            if (attempt > 50) throw error;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
}, 60_000);

afterAll(async () => {
    console.log(["", "| chemin | écrivains | lot | échantillons/s | appels/s | p50 ms | p95 ms | erreurs |", "|---|---|---|---|---|---|---|---|", ...rows].join("\n"));
    for (const client of clients) client.disconnect();
    slotTransport?.close();
    await slotStore?.closeAsync();
    await broker?.stop();
    rmSync(dir, { recursive: true, force: true });
});

async function slotWriter(): Promise<HistorySlotStore> {
    const url = `http://127.0.0.1:${new URL(broker.url).port}/history/mcp`;
    const client = new McpClient({ name: "history-bench", version: "0.1.0" }, new StreamableHttpTransport(url, { headers: broker.bearer("recorder") }), 30_000);
    await client.connect();
    clients.push(client);
    return new HistorySlotStore("history", client);
}

it("measures appends, in process and through the broker", async () => {
    const direct = new SqliteHistoryStore({ path: join(dir, "direct.db") });
    for (const size of BATCHES) {
        await measure("direct SQLite", 1, size, (samples) => direct.appendAsync(samples));
    }
    console.log(`direct.db: ${(statSync(join(dir, "direct.db")).size / 1048576).toFixed(1)} Mio`);
    await direct.closeAsync();

    for (const size of BATCHES) {
        const writer = await slotWriter();
        await measure("slot via broker", 1, size, (samples) => writer.appendAsync(samples));
    }
    for (const writers of WRITERS.filter((count) => count > 1)) {
        const stores = await Promise.all(Array.from({ length: writers }, slotWriter));
        let next = 0;
        await measure("slot via broker", writers, 100, (samples) => stores[next++ % writers]!.appendAsync(samples));
    }
}, 900_000);
