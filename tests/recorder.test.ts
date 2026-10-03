import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HistoryError, MemoryHistoryStore, type IHistorySample, type IHistoryStore, type IRawColumns } from "@cyanmycelium/mcp-history";
import { HistoryRecorder, SqliteRecorderBuffer, type IScadaReader, type RecorderEvent, type ScadaReadItem } from "@cyanmycelium/mcp-history-recorder";

const SPEED = "uns://site1/line1/motor01/speed";
const STATE = "uns://site1/line1/motor01/state";
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const dir = mkdtempSync(join(tmpdir(), "mcp-history-recorder-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A SCADA reader whose answers the test sets, read after read. */
class FakeReader implements IScadaReader {
    values = new Map<string, unknown>();
    failing = new Map<string, string>();
    down = false;
    clock = { t: T0 };

    async readAsync(ids: readonly string[]): Promise<ScadaReadItem[]> {
        if (this.down) throw new Error("scada slot unreachable");
        return ids.map((id) =>
            this.failing.has(id)
                ? { id, error: { code: this.failing.get(id)!, message: "failed" } }
                : {
                      id,
                      value: this.values.get(id),
                      quality: "good" as const,
                      sourceTimestamp: null,
                      receivedTimestamp: new Date(this.clock.t).toISOString(),
                      provenance: { provider: "modbus-bench" },
                  }
        );
    }
}

/** A sink that can be switched off, as a history slot that went down. */
class FlakySink {
    down = false;
    calls = 0;
    constructor(readonly inner: IHistoryStore) {}
    asStore(): IHistoryStore {
        return Object.assign(Object.create(this.inner) as IHistoryStore, {
            appendAsync: async (samples: readonly IHistorySample[]) => {
                this.calls++;
                if (this.down) throw new HistoryError("store_unavailable", "history slot down");
                return this.inner.appendAsync(samples);
            },
        });
    }
}

async function recorded(store: IHistoryStore, id: string): Promise<IRawColumns> {
    const read = await store.readRawAsync({ ids: [id], start: new Date(T0 - 3_600_000).toISOString(), end: new Date(T0 + 3_600_000).toISOString(), format: "columns" });
    return read.series[0] as IRawColumns;
}

function setup(tags: ConstructorParameters<typeof HistoryRecorder>[0]["tags"], extra: Partial<ConstructorParameters<typeof HistoryRecorder>[0]> = {}) {
    const reader = new FakeReader();
    const store = new MemoryHistoryStore();
    const sink = new FlakySink(store);
    const events: RecorderEvent[] = [];
    const recorder = new HistoryRecorder({ reader, sink: sink.asStore(), tags, now: () => reader.clock.t, onEvent: (event) => events.push(event), ...extra });
    const tick = async (ms = 1_000) => {
        reader.clock.t += ms;
        await recorder.pollAsync();
    };
    return { reader, store, sink, recorder, events, tick };
}

describe("HistoryRecorder", () => {
    it("records every read in periodic mode, through the buffer", async () => {
        const { reader, store, recorder, tick } = setup([{ id: SPEED, periodMs: 1_000 }]);
        reader.values.set(SPEED, 1450);
        await tick();
        await tick();
        await tick();
        expect((await recorder.statsAsync()).buffered).toBe(3);
        expect(await recorder.flushAsync()).toEqual({ appended: 3, duplicates: 0, rejected: 0 });
        expect((await recorded(store, SPEED)).value).toEqual([1450, 1450, 1450]);
        expect((await recorder.statsAsync()).buffered).toBe(0);
    });

    it("records on change only beyond the deadband, and after maxSilenceMs anyway", async () => {
        const { reader, store, recorder, tick } = setup([{ id: SPEED, periodMs: 1_000, mode: "on-change", deadband: 5, maxSilenceMs: 10_000 }]);
        for (const value of [1450, 1452, 1449, 1460, 1460, 1458]) {
            reader.values.set(SPEED, value);
            await tick();
        }
        await tick(10_000); // still 1458, but silent for 10 s
        await recorder.flushAsync();
        expect((await recorded(store, SPEED)).value).toEqual([1450, 1460, 1458]);
    });

    it("records a value whose type or structure changed", async () => {
        const { reader, store, recorder, tick } = setup([{ id: STATE, periodMs: 1_000, mode: "on-change" }]);
        for (const value of ["stopped", "stopped", { mode: "auto" }, { mode: "auto" }, { mode: "manual" }]) {
            reader.values.set(STATE, value);
            await tick();
        }
        await recorder.flushAsync();
        expect((await recorded(store, STATE)).value).toEqual(["stopped", { mode: "auto" }, { mode: "manual" }]);
    });

    it("records an unreachable device as bad, and a refusal not at all", async () => {
        const { reader, store, recorder, events, tick } = setup([
            { id: SPEED, periodMs: 1_000, mode: "on-change" },
            { id: STATE, periodMs: 1_000 },
        ]);
        reader.values.set(SPEED, 1450);
        reader.failing.set(STATE, "policy_denied");
        await tick();
        reader.failing.set(SPEED, "native_protocol_error");
        await tick();
        await tick();
        reader.failing.delete(SPEED);
        await tick();
        await recorder.flushAsync();

        const speed = await recorded(store, SPEED);
        expect(speed.value).toEqual([1450, null, 1450]);
        expect(speed.quality).toEqual(["good", "bad", "good"]);
        expect(speed.provider).toEqual(["modbus-bench", "recorder", "modbus-bench"]);
        expect((await recorded(store, STATE)).value).toEqual([]);
        expect(events.filter((event) => event.type === "read-refused")).toHaveLength(4);
    });

    it("treats a scada slot that cannot be reached as a failed read of every tag", async () => {
        const { reader, store, recorder, events, tick } = setup([{ id: SPEED, periodMs: 1_000 }]);
        reader.down = true;
        await tick();
        await recorder.flushAsync();
        expect((await recorded(store, SPEED)).quality).toEqual(["bad"]);
        expect(events[0]).toMatchObject({ type: "read-failed", ids: [SPEED] });
        expect((await recorder.statsAsync()).readFailures).toBe(1);
    });

    it("keeps samples while the history is down, backs off, then replays them without duplicates", async () => {
        const { reader, store, sink, recorder, events, tick } = setup([{ id: SPEED, periodMs: 1_000 }], { flushIntervalMs: 1_000, retryMaxMs: 4_000 });
        reader.values.set(SPEED, 1450);
        await tick();
        sink.down = true;
        await recorder.flushAsync();
        expect(events.at(-1)).toMatchObject({ type: "flush-failed", retryInMs: 1_000 });
        await tick();
        reader.clock.t += 1_000;
        await recorder.flushAsync();
        expect(events.at(-1)).toMatchObject({ type: "flush-failed", retryInMs: 2_000 });
        const callsBefore = sink.calls;
        await recorder.flushAsync(); // inside the back-off: not even tried
        expect(sink.calls).toBe(callsBefore);
        expect((await recorder.statsAsync()).buffered).toBe(2);

        sink.down = false;
        await recorder.flushAsync({ force: true });
        expect((await recorded(store, SPEED)).value).toEqual([1450, 1450]);
        // The same samples once more, as after a crash between append and acknowledgement.
        const replay = await store.appendAsync([
            { id: SPEED, value: 1450, quality: "good", sourceTimestamp: null, receivedTimestamp: new Date(T0 + 1_000).toISOString(), provider: "modbus-bench" },
        ]);
        expect(replay).toEqual({ accepted: 0, duplicates: 1, rejected: [] });
    });

    it("halves its batch when the sink says it is too large", async () => {
        const { reader, store, recorder, tick } = setup([{ id: SPEED, periodMs: 1_000 }], { sink: new MemoryHistoryStore({ limits: { maxSamplesPerAppend: 3 } }), maxBatch: 8 });
        void store;
        reader.values.set(SPEED, 1);
        for (let i = 0; i < 7; i++) await tick();
        expect(await recorder.flushAsync()).toMatchObject({ appended: 7 });
    });

    it("survives a restart with a SQLite buffer", async () => {
        const path = join(dir, "buffer.db");
        const reader = new FakeReader();
        reader.values.set(SPEED, 1450);
        const sink = new FlakySink(new MemoryHistoryStore());
        sink.down = true;
        const first = new HistoryRecorder({
            reader,
            sink: sink.asStore(),
            buffer: new SqliteRecorderBuffer(path),
            tags: [{ id: SPEED, periodMs: 1_000 }],
            now: () => reader.clock.t,
        });
        await first.pollAsync();
        reader.clock.t += 1_000;
        await first.pollAsync();
        await first.closeAsync(); // the last flush fails: the samples stay on disk

        sink.down = false;
        const second = new HistoryRecorder({
            reader,
            sink: sink.asStore(),
            buffer: new SqliteRecorderBuffer(path),
            tags: [{ id: SPEED, periodMs: 1_000 }],
            now: () => reader.clock.t,
        });
        expect((await second.statsAsync()).buffered).toBe(2);
        expect(await second.flushAsync()).toMatchObject({ appended: 2 });
        await second.closeAsync();
        expect((await recorded(sink.inner, SPEED)).value).toEqual([1450, 1450]);
    });

    it("drops the oldest samples past the buffer size, and counts them", async () => {
        const reader = new FakeReader();
        reader.values.set(SPEED, 1);
        const sink = new FlakySink(new MemoryHistoryStore());
        sink.down = true;
        const recorder = new HistoryRecorder({
            reader,
            sink: sink.asStore(),
            buffer: new SqliteRecorderBuffer(":memory:", 3),
            tags: [{ id: SPEED, periodMs: 1_000 }],
            now: () => reader.clock.t,
        });
        for (let i = 0; i < 5; i++) {
            reader.values.set(SPEED, i);
            reader.clock.t += 1_000;
            await recorder.pollAsync();
        }
        expect(await recorder.statsAsync()).toMatchObject({ buffered: 3, dropped: 2 });
        sink.down = false;
        await recorder.flushAsync({ force: true });
        expect((await recorded(sink.inner, SPEED)).value).toEqual([2, 3, 4]);
    });

    it("refuses an empty or duplicated tag list", () => {
        const reader = new FakeReader();
        const sink = new MemoryHistoryStore();
        expect(() => new HistoryRecorder({ reader, sink, tags: [] })).toThrow(/no tag/);
        expect(
            () =>
                new HistoryRecorder({
                    reader,
                    sink,
                    tags: [
                        { id: SPEED, periodMs: 1_000 },
                        { id: SPEED, periodMs: 500 },
                    ],
                })
        ).toThrow(/twice/);
    });
});
