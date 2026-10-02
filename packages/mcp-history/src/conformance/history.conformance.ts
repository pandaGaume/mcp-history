import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HistoryError } from "../contract/errors";
import type { IHistoryStore } from "../contract/history.store";
import {
    isSeriesError,
    type IAtTimeSeries,
    type IHistoryCapabilities,
    type IHistorySample,
    type IProcessedSeries,
    type IRawSeries,
    type IStoredSample,
    type Quality,
} from "../contract/history.types";

export interface IHistoryConformanceOptions {
    /** Called after each test, after `closeAsync`: drop a database, a temp file... */
    readonly cleanupAsync?: () => Promise<void>;
}

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

const A = "uns://site1/line1/motor01/speed";
const B = "uns://site1/line1/motor01/temperature";
const C = "uns://site1/line1/motor01/state";
const SIBLING = "uns://site1/line1/motor01x/speed";

function sample(id: string, seconds: number, value: unknown, quality: Quality = "good", source = true, receivedOffset = 0.5): IHistorySample {
    return {
        id,
        value,
        quality,
        sourceTimestamp: source ? at(seconds) : null,
        receivedTimestamp: at(seconds + receivedOffset),
        provider: "conformance",
    };
}

async function rejection(promise: Promise<unknown>): Promise<HistoryError> {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(HistoryError);
        return error as HistoryError;
    }
    throw new Error("expected the call to reject with a HistoryError");
}

function raw(series: readonly object[], id: string): IStoredSample[] {
    const found = series.find((item) => (item as { id: string }).id === id);
    if (!found || isSeriesError(found)) throw new Error(`no data series for ${id}`);
    return [...(found as IRawSeries).samples];
}

/**
 * The history.v1 conformance suite: what every store must do, whatever it
 * stores in. A store passes it directly, and again through a slot
 * (`HistoryBehavior` + `HistorySlotStore`), which proves that the MCP form of
 * the contract says the same thing as the TypeScript form.
 *
 * @param factory returns a new, empty store for each test
 */
export function describeHistoryStoreConformance(name: string, factory: () => IHistoryStore | Promise<IHistoryStore>, options: IHistoryConformanceOptions = {}): void {
    describe(`history.v1 conformance: ${name}`, () => {
        let store: IHistoryStore;
        let capabilities: IHistoryCapabilities;

        beforeEach(async () => {
            store = await factory();
            capabilities = await store.getCapabilitiesAsync();
        });

        afterEach(async () => {
            // A factory that failed left no store: let its own error be the one reported.
            await store?.closeAsync();
            await options.cleanupAsync?.();
        });

        const supports = (type: IHistoryCapabilities["valueTypes"][number]) => capabilities.valueTypes.includes(type);

        describe("capabilities", () => {
            it("declares history.v1 with positive limits", () => {
                expect(capabilities.interface).toBe("history.v1");
                expect(capabilities.store).toEqual(expect.any(String));
                expect(capabilities.valueTypes).toContain("number");
                for (const limit of Object.values(capabilities.limits)) expect(limit).toBeGreaterThan(0);
            });
        });

        describe("append and read_raw", () => {
            it("reads back what was appended, with normalized timestamps and the time axis it was filed under", async () => {
                const result = await store.appendAsync([sample(A, 1, 10), sample(A, 2, 11, "uncertain", false)]);
                expect(result).toEqual({ accepted: 2, duplicates: 0, rejected: [] });

                const read = await store.readRawAsync({ ids: [A], start: at(0), end: at(10) });
                expect(read.continuationPoint).toBeNull();
                expect(raw(read.series, A)).toEqual([
                    {
                        id: A,
                        value: 10,
                        quality: "good",
                        sourceTimestamp: at(1),
                        receivedTimestamp: at(1.5),
                        provider: "conformance",
                        time: at(1),
                        timeOrigin: "source",
                    },
                    {
                        id: A,
                        value: 11,
                        quality: "uncertain",
                        sourceTimestamp: null,
                        receivedTimestamp: at(2.5),
                        provider: "conformance",
                        time: at(2.5),
                        timeOrigin: "received",
                    },
                ]);
            });

            it("accepts timestamps with an offset and returns them in UTC", async () => {
                await store.appendAsync([{ ...sample(A, 0, 1), sourceTimestamp: "2026-01-01T02:00:03+02:00", receivedTimestamp: "2026-01-01T02:00:04.000+02:00" }]);
                const [stored] = raw((await store.readRawAsync({ ids: [A], start: at(0), end: at(10) })).series, A);
                expect(stored).toMatchObject({ time: at(3), sourceTimestamp: at(3), receivedTimestamp: at(4) });
            });

            it("records every declared value type", async () => {
                const values: Record<string, unknown> = { number: 3.5, boolean: true, string: "running", json: { mode: "auto", steps: [1, 2] } };
                const declared = Object.entries(values).filter(([type]) => supports(type as never));
                await store.appendAsync(declared.map(([, value], index) => sample(C, index, value)));
                expect(raw((await store.readRawAsync({ ids: [C], start: at(0), end: at(10) })).series, C).map((item) => item.value)).toEqual(declared.map(([, value]) => value));
            });

            it("rejects a value type it does not declare, per sample", async () => {
                const undeclared = (["boolean", "string", "json"] as const).find((type) => !supports(type));
                if (!undeclared) return;
                const value = { boolean: true, string: "x", json: { a: 1 } }[undeclared];
                const result = await store.appendAsync([sample(A, 1, 1), sample(A, 2, value)]);
                expect(result.accepted).toBe(1);
                expect(result.rejected).toEqual([{ index: 1, error: expect.objectContaining({ code: "unsupported_value_type" }) }]);
            });

            it("records bad-quality samples and reads them back", async () => {
                await store.appendAsync([sample(A, 1, 0, "bad")]);
                expect(raw((await store.readRawAsync({ ids: [A], start: at(0), end: at(10) })).series, A)[0]).toMatchObject({ quality: "bad", value: 0 });
            });

            it("is idempotent on (id, time, receivedTimestamp)", async () => {
                await store.appendAsync([sample(A, 1, 10), sample(A, 2, 11)]);
                const replay = await store.appendAsync([sample(A, 1, 10), sample(A, 2, 11), sample(A, 3, 12)]);
                expect(replay).toEqual({ accepted: 1, duplicates: 2, rejected: [] });
                expect(raw((await store.readRawAsync({ ids: [A], start: at(0), end: at(10) })).series, A)).toHaveLength(3);
            });

            it("keeps two samples at the same time received at different moments, in reception order", async () => {
                await store.appendAsync([sample(A, 1, 2, "good", true, 0.9), sample(A, 1, 1, "good", true, 0.1)]);
                expect(raw((await store.readRawAsync({ ids: [A], start: at(0), end: at(10) })).series, A).map((item) => item.value)).toEqual([1, 2]);
            });

            it("rejects malformed samples one by one and keeps the others", async () => {
                const result = await store.appendAsync([
                    sample(A, 1, 1),
                    { ...sample(A, 2, 2), id: "site1/line1" },
                    { ...sample(A, 3, 3), receivedTimestamp: "yesterday" },
                    { ...sample(A, 4, 4), sourceTimestamp: "2026-01-01T00:00:04" },
                    { ...sample(A, 5, 5), quality: "fine" as Quality },
                    // NaN cannot travel in JSON; a missing value is what a slot would see.
                    { ...sample(A, 6, 0), value: undefined },
                    sample(A, 7, 7),
                ]);
                expect(result.accepted).toBe(2);
                expect(result.rejected.map((item) => item.index)).toEqual([1, 2, 3, 4, 5]);
                for (const item of result.rejected) expect(item.error.code).toBe("invalid_request");
            });

            it("reads [start, end): start included, end excluded", async () => {
                await store.appendAsync([sample(A, 1, 1), sample(A, 2, 2), sample(A, 3, 3)]);
                expect(raw((await store.readRawAsync({ ids: [A], start: at(1), end: at(3) })).series, A).map((item) => item.value)).toEqual([1, 2]);
            });

            it("orders by requested id, then by time, whatever the append order", async () => {
                await store.appendAsync([sample(B, 3, 30), sample(A, 2, 20), sample(B, 1, 10), sample(A, 1, 5)]);
                const read = await store.readRawAsync({ ids: [B, A], start: at(0), end: at(10) });
                expect(read.series.map((item) => item.id)).toEqual([B, A]);
                expect(raw(read.series, B).map((item) => item.value)).toEqual([10, 30]);
                expect(raw(read.series, A).map((item) => item.value)).toEqual([5, 20]);
            });

            it("returns an empty series for an id without history", async () => {
                expect((await store.readRawAsync({ ids: [A], start: at(0), end: at(10) })).series).toEqual([{ id: A, samples: [] }]);
            });

            it("pages through every sample exactly once", async () => {
                await store.appendAsync([...[0, 1, 2, 3].map((s) => sample(A, s, s)), ...[0, 1, 2].map((s) => sample(B, s, 10 + s))]);
                const seen: Record<string, unknown[]> = { [A]: [], [B]: [] };
                let continuationPoint: string | undefined;
                let pages = 0;
                do {
                    const page = await store.readRawAsync({ ids: [A, B], start: at(0), end: at(10), limit: 3, ...(continuationPoint ? { continuationPoint } : {}) });
                    const count = page.series.reduce((total, item) => total + (isSeriesError(item) ? 0 : item.samples.length), 0);
                    expect(count).toBeLessThanOrEqual(3);
                    for (const item of page.series) if (!isSeriesError(item)) seen[item.id]!.push(...item.samples.map((s) => s.value));
                    continuationPoint = page.continuationPoint ?? undefined;
                    expect(++pages).toBeLessThan(10);
                } while (continuationPoint);
                expect(seen).toEqual({ [A]: [0, 1, 2, 3], [B]: [10, 11, 12] });
                expect(pages).toBe(3);
            });
        });

        describe("read_processed", () => {
            // Prior 2 at -5 s; then 4 good, 6 uncertain, 100 bad, 8 good in [0, 10); nothing in [10, 20); 10 at 22 s.
            const series = () => [sample(A, -5, 2), sample(A, 1, 4), sample(A, 2, 6, "uncertain"), sample(A, 4, 100, "bad"), sample(A, 6, 8), sample(A, 22, 10)];
            const all = ["count", "min", "max", "sum", "avg", "first", "last", "timeWeightedAvg", "goodRatio"] as const;

            it("computes every aggregate with the reference semantics", async () => {
                await store.appendAsync(series());
                const result = await store.readProcessedAsync({ ids: [A], start: at(0), end: at(25), intervalMs: 10_000, aggregates: [...all] });
                const [processed] = result.series as IProcessedSeries[];
                expect(processed!.computedBy).toMatch(/^(store|router)$/);
                expect(processed!.buckets.map((bucket) => [bucket.start, bucket.end])).toEqual([
                    [at(0), at(10)],
                    [at(10), at(20)],
                    [at(20), at(25)],
                ]);
                const [first, empty, partial] = processed!.buckets.map((bucket) => bucket.values);
                expect(first).toEqual({ count: 3, min: 4, max: 8, sum: 18, avg: 6, first: 4, last: 8, timeWeightedAvg: 6.25, goodRatio: 0.5 });
                expect(empty).toEqual({ count: 0, min: null, max: null, sum: null, avg: null, first: null, last: null, timeWeightedAvg: 8, goodRatio: null });
                expect(partial!.count).toBe(1);
                expect(partial!.timeWeightedAvg).toBeCloseTo(9.2, 10);
                expect(partial!.goodRatio).toBe(1);
            });

            it("returns only the aggregates asked for", async () => {
                await store.appendAsync(series());
                const [processed] = (await store.readProcessedAsync({ ids: [A], start: at(0), end: at(10), intervalMs: 10_000, aggregates: ["max"] })).series as IProcessedSeries[];
                expect(processed!.buckets[0]!.values).toEqual({ max: 8 });
            });

            it("counts non-numeric values without inventing a numeric aggregate", async () => {
                if (!supports("string")) return;
                await store.appendAsync([sample(C, 1, "starting"), sample(C, 2, "running")]);
                const [processed] = (
                    await store.readProcessedAsync({ ids: [C], start: at(0), end: at(10), intervalMs: 10_000, aggregates: ["count", "avg", "last", "timeWeightedAvg"] })
                ).series as IProcessedSeries[];
                expect(processed!.buckets[0]!.values).toEqual({ count: 2, avg: null, last: "running", timeWeightedAvg: null });
            });

            it("refuses more buckets than the store allows", async () => {
                const error = await rejection(
                    store.readProcessedAsync({ ids: [A], start: at(0), end: at(capabilities.limits.maxBucketsPerRead + 1), intervalMs: 1000, aggregates: ["count"] })
                );
                expect(error.code).toBe("limit_exceeded");
            });
        });

        describe("read_at_time", () => {
            it("answers exact, stepped, interpolated and none, in the order of times", async () => {
                await store.appendAsync([sample(A, 1, 4), sample(A, 2, 6, "uncertain"), sample(A, 4, 100, "bad"), sample(A, 6, 8)]);
                const stepped = (await store.readAtTimeAsync({ ids: [A], times: [at(1.5), at(1), at(0), at(5)], mode: "stepped" })).series[0] as IAtTimeSeries;
                expect(stepped.values).toEqual([
                    { time: at(1.5), value: 4, quality: "good", basis: "stepped" },
                    { time: at(1), value: 4, quality: "good", basis: "exact" },
                    { time: at(0), value: null, quality: null, basis: "none" },
                    { time: at(5), value: 100, quality: "bad", basis: "stepped" },
                ]);
                const interpolated = (await store.readAtTimeAsync({ ids: [A], times: [at(1.5), at(5), at(60)], mode: "interpolated" })).series[0] as IAtTimeSeries;
                expect(interpolated.values).toEqual([
                    { time: at(1.5), value: 5, quality: "uncertain", basis: "interpolated" },
                    // Next to a bad sample: no interpolation, the last sample stands.
                    { time: at(5), value: 100, quality: "bad", basis: "stepped" },
                    // After the last sample: nothing is extrapolated.
                    { time: at(60), value: 8, quality: "good", basis: "stepped" },
                ]);
            });

            it("never interpolates booleans", async () => {
                if (!supports("boolean")) return;
                await store.appendAsync([sample(C, 0, false), sample(C, 2, true)]);
                const series = (await store.readAtTimeAsync({ ids: [C], times: [at(1)], mode: "interpolated" })).series[0] as IAtTimeSeries;
                expect(series.values[0]).toMatchObject({ value: false, basis: "stepped" });
            });
        });

        describe("browse", () => {
            it("lists ids with history under a root, by whole segments, with first, last and count", async () => {
                await store.appendAsync([sample(A, 1, 1), sample(A, 5, 2), sample(B, 3, 3), sample(SIBLING, 1, 1)]);
                const result = await store.browseAsync({ root: "uns://site1/line1/motor01" });
                expect(result).toEqual({
                    items: [
                        { id: A, first: at(1), last: at(5), count: 2 },
                        { id: B, first: at(3), last: at(3), count: 1 },
                    ],
                    continuationPoint: null,
                });
            });

            it("pages through ids", async () => {
                await store.appendAsync(
                    [sample(A, 1, 1), sample(B, 1, 1), sample(C, 1, "x"), sample(SIBLING, 1, 1)].filter((s) => supports(typeof s.value === "string" ? "string" : "number"))
                );
                const ids: string[] = [];
                let continuationPoint: string | undefined;
                do {
                    const page = await store.browseAsync({ limit: 2, ...(continuationPoint ? { continuationPoint } : {}) });
                    expect(page.items.length).toBeLessThanOrEqual(2);
                    ids.push(...page.items.map((item) => item.id));
                    continuationPoint = page.continuationPoint ?? undefined;
                } while (continuationPoint);
                expect(ids).toEqual([...ids].sort());
                expect(new Set(ids).size).toBe(ids.length);
                expect(ids).toContain(SIBLING);
            });
        });

        describe("delete_range", () => {
            it("deletes [start, end) of the given ids only, or declares it cannot", async () => {
                await store.appendAsync([sample(A, 1, 1), sample(A, 2, 2), sample(A, 3, 3), sample(B, 2, 2)]);
                if (!capabilities.operations.delete) {
                    expect((await rejection(store.deleteRangeAsync({ ids: [A], start: at(0), end: at(10) }))).code).toBe("unsupported_capability");
                    return;
                }
                expect(await store.deleteRangeAsync({ ids: [A], start: at(2), end: at(3) })).toEqual({ deleted: 1, errors: [] });
                expect(raw((await store.readRawAsync({ ids: [A], start: at(0), end: at(10) })).series, A).map((item) => item.value)).toEqual([1, 3]);
                expect(raw((await store.readRawAsync({ ids: [B], start: at(0), end: at(10) })).series, B)).toHaveLength(1);
            });

            it("forgets an id whose history was entirely deleted", async () => {
                if (!capabilities.operations.delete) return;
                await store.appendAsync([sample(A, 1, 1), sample(B, 1, 1)]);
                await store.deleteRangeAsync({ ids: [A], start: at(0), end: at(10) });
                expect((await store.browseAsync({})).items.map((item) => item.id)).toEqual([B]);
            });
        });

        describe("request validation", () => {
            const cases: [string, () => Promise<unknown>][] = [
                ["end before start", () => store.readRawAsync({ ids: [A], start: at(10), end: at(0) })],
                ["a time without offset", () => store.readRawAsync({ ids: [A], start: "2026-01-01T00:00:00", end: at(10) })],
                ["no ids", () => store.readRawAsync({ ids: [], start: at(0), end: at(10) })],
                ["a duplicated id", () => store.readRawAsync({ ids: [A, A], start: at(0), end: at(10) })],
                ["a non-canonical id", () => store.readRawAsync({ ids: ["uns://site1/line1/"], start: at(0), end: at(10) })],
                ["an unknown aggregate", () => store.readProcessedAsync({ ids: [A], start: at(0), end: at(10), intervalMs: 1000, aggregates: ["median" as never] })],
                ["a zero interval", () => store.readProcessedAsync({ ids: [A], start: at(0), end: at(10), intervalMs: 0, aggregates: ["count"] })],
                ["an unknown at-time mode", () => store.readAtTimeAsync({ ids: [A], times: [at(1)], mode: "nearest" as never })],
                ["a forged continuation point", () => store.readRawAsync({ ids: [A], start: at(0), end: at(10), continuationPoint: "not-a-point" })],
            ];
            for (const [label, call] of cases) {
                it(`refuses ${label} with invalid_request`, async () => {
                    expect((await rejection(call())).code).toBe("invalid_request");
                });
            }

            it("refuses a page larger than the store allows", async () => {
                const error = await rejection(store.readRawAsync({ ids: [A], start: at(0), end: at(10), limit: capabilities.limits.maxPointsPerRead + 1 }));
                expect(error.code).toBe("limit_exceeded");
            });
        });

        describe("isolation", () => {
            it("does not share objects with its callers", async () => {
                if (!supports("json")) return;
                const value = { mode: "auto" };
                await store.appendAsync([sample(C, 1, value)]);
                value.mode = "changed";
                const first = raw((await store.readRawAsync({ ids: [C], start: at(0), end: at(10) })).series, C)[0]!;
                (first.value as { mode: string }).mode = "mutated";
                const second = raw((await store.readRawAsync({ ids: [C], start: at(0), end: at(10) })).series, C)[0]!;
                expect(second.value).toEqual({ mode: "auto" });
            });
        });
    });
}
