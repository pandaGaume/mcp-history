import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { LoopbackTransport, McpClient, McpServerBuilder } from "@cyanmycelium/mcp-core";
import { HistoryBehavior, HistorySlotStore, type IHistoryStore } from "@cyanmycelium/mcp-history";
import { describeHistoryStoreConformance } from "@cyanmycelium/mcp-history/conformance";
import { SqliteHistoryStore } from "@cyanmycelium/mcp-history-sqlite";
import { openGuard } from "@cyanmycelium/mcp-uns";

const dir = mkdtempSync(join(tmpdir(), "mcp-history-sqlite-"));
let files = 0;
const nextFile = () => join(dir, `store-${++files}.db`);

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

describeHistoryStoreConformance("SqliteHistoryStore in memory", () => new SqliteHistoryStore({ path: ":memory:" }));

describeHistoryStoreConformance("SqliteHistoryStore on a file", () => new SqliteHistoryStore({ path: nextFile() }));

describeHistoryStoreConformance("SqliteHistoryStore through a history slot", async (): Promise<IHistoryStore> => {
    const store = new SqliteHistoryStore({ path: ":memory:" });
    const [serverEnd, clientEnd] = LoopbackTransport.createPair();
    await new McpServerBuilder()
        .withName("history")
        .withTransport(serverEnd)
        .register(new HistoryBehavior(store, openGuard(), { payload: "structured" }))
        .build()
        .start();
    const client = new McpClient({ name: "conformance", version: "0.1.0" }, clientEnd, 5_000);
    await client.connect();
    const remote = new HistorySlotStore("history", client);
    return Object.assign(Object.create(remote) as IHistoryStore, {
        async closeAsync() {
            client.disconnect();
            await store.closeAsync();
        },
    });
});

const SPEED = "uns://site1/line1/motor01/speed";
const sample = (seconds: number, value: unknown) => ({
    id: SPEED,
    value,
    quality: "good" as const,
    sourceTimestamp: null,
    receivedTimestamp: new Date(Date.parse("2026-01-01T00:00:00.000Z") + seconds * 1000).toISOString(),
    provider: "bench",
});

describe("SqliteHistoryStore on disk", () => {
    it("keeps its samples across a reopening", async () => {
        const path = nextFile();
        const first = new SqliteHistoryStore({ path });
        await first.appendAsync([sample(1, 10), sample(2, 11)]);
        await first.closeAsync();

        const second = new SqliteHistoryStore({ path });
        const read = await second.readRawAsync({ ids: [SPEED], start: "2026-01-01T00:00:00.000Z", end: "2026-01-02T00:00:00.000Z", format: "columns" });
        expect(read.series[0]).toMatchObject({ value: [10, 11] });
        expect(await second.getCapabilitiesAsync()).toMatchObject({ store: "sqlite", durability: "local-disk" });
        await second.closeAsync();
    });

    it("refuses a file written with another schema version", async () => {
        const path = nextFile();
        await new SqliteHistoryStore({ path }).closeAsync();
        const db = new Database(path);
        db.prepare("UPDATE history_meta SET value = '99' WHERE key = 'schema_version'").run();
        db.close();
        expect(() => new SqliteHistoryStore({ path })).toThrow(/schema version 99/);
    });

    it("writes a table any SQL tool can read: one row per sample, typed, with both timestamps", async () => {
        const path = nextFile();
        const store = new SqliteHistoryStore({ path });
        await store.appendAsync([sample(1, 10.5), sample(2, true), sample(3, "running"), sample(4, { mode: "auto" })]);
        await store.closeAsync();

        const db = new Database(path, { readonly: true });
        expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
        const rows = db.prepare("SELECT value_type, value_num, value_text, quality, source_ms, received_ms - t_ms AS lag FROM history_samples ORDER BY t_ms").all();
        db.close();
        expect(rows).toEqual([
            { value_type: "n", value_num: 10.5, value_text: null, quality: "g", source_ms: null, lag: 0 },
            { value_type: "b", value_num: 1, value_text: null, quality: "g", source_ms: null, lag: 0 },
            { value_type: "s", value_num: null, value_text: "running", quality: "g", source_ms: null, lag: 0 },
            { value_type: "j", value_num: null, value_text: '{"mode":"auto"}', quality: "g", source_ms: null, lag: 0 },
        ]);
    });
});
