import { decodeContinuation, encodeContinuation } from "../contract/continuation";
import { HistoryError, invalid } from "../contract/errors";
import type { IHistoryStore } from "../contract/history.store";
import {
    AGGREGATES,
    VALUE_TYPES,
    type IAppendResult,
    type IAtTimeSeries,
    type IDeleteRangeRequest,
    type IDeleteRangeResult,
    type IHistoryBrowseItem,
    type IHistoryBrowseRequest,
    type IHistoryBrowseResult,
    type IHistoryCapabilities,
    type IHistorySample,
    type IProcessedSeries,
    type IRawSeries,
    type IReadAtTimeRequest,
    type IReadAtTimeResult,
    type IReadProcessedRequest,
    type IReadProcessedResult,
    type IReadRawRequest,
    type IReadRawResult,
    type IRejectedSample,
    type IStoredSample,
} from "../contract/history.types";
import { checkBucketRequest, compareTimed, computeBuckets, locate, valueAtTime, type ITimedValue } from "../contract/semantics";
import {
    formatInstant,
    isNormalizedSample,
    normalizeSample,
    parseAggregates,
    parseAtTimeMode,
    parseIds,
    parseInstant,
    parseLimit,
    parseRange,
    parseRoot,
} from "../contract/validation";
import { UnsPath, type UnsId } from "@cyanmycelium/mcp-uns";

interface IRecord extends ITimedValue {
    readonly sample: IStoredSample;
}

export interface IMemoryHistoryStoreOptions {
    readonly id?: string;
    readonly limits?: Partial<IHistoryCapabilities["limits"]>;
}

const DEFAULT_LIMITS: IHistoryCapabilities["limits"] = {
    maxSamplesPerAppend: 10_000,
    maxPointsPerRead: 10_000,
    maxBucketsPerRead: 10_000,
    maxBrowseItems: 1_000,
};

function clone<T>(value: T): T {
    return typeof value === "object" && value !== null ? structuredClone(value) : value;
}

/** First index whose record is at or after `timeMs`. */
function lowerBound(records: readonly IRecord[], timeMs: number): number {
    let low = 0;
    let high = records.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (records[middle]!.timeMs < timeMs) low = middle + 1;
        else high = middle;
    }
    return low;
}

/**
 * history.v1 in memory: every value type, every aggregate, delete supported.
 *
 * Meant for tests, benches and the conformance suite, which takes it as the
 * reference: its aggregates are the contract's reference semantics, verbatim.
 * Nothing survives the process.
 */
export class MemoryHistoryStore implements IHistoryStore {
    readonly id: string;
    private readonly _capabilities: IHistoryCapabilities;
    private readonly _series = new Map<UnsId, IRecord[]>();
    private _closed = false;

    constructor(options: IMemoryHistoryStoreOptions = {}) {
        this.id = options.id ?? "memory";
        this._capabilities = {
            interface: "history.v1",
            store: "memory",
            valueTypes: [...VALUE_TYPES],
            nativeAggregates: [...AGGREGATES],
            operations: { delete: true },
            retention: { maxAgeMs: null },
            durability: "memory",
            limits: { ...DEFAULT_LIMITS, ...options.limits },
        };
    }

    async getCapabilitiesAsync(signal?: AbortSignal): Promise<IHistoryCapabilities> {
        this._enter(signal);
        return structuredClone(this._capabilities);
    }

    async appendAsync(samples: readonly IHistorySample[], signal?: AbortSignal): Promise<IAppendResult> {
        this._enter(signal);
        if (!Array.isArray(samples)) throw invalid("samples must be an array");
        const max = this._capabilities.limits.maxSamplesPerAppend;
        if (samples.length > max) throw new HistoryError("limit_exceeded", `${samples.length} samples sent, the store maximum is ${max}`, { detail: { max } });

        let accepted = 0;
        let duplicates = 0;
        const rejected: IRejectedSample[] = [];
        samples.forEach((sample, index) => {
            const normalized = normalizeSample(sample, this._capabilities);
            if (!isNormalizedSample(normalized)) {
                rejected.push({ index, error: normalized });
                return;
            }
            const records = this._series.get(normalized.id) ?? [];
            const record: IRecord = {
                timeMs: normalized.timeMs,
                receivedMs: normalized.receivedMs,
                value: clone(normalized.value),
                quality: normalized.quality,
                sample: {
                    id: normalized.id,
                    value: clone(normalized.value),
                    quality: normalized.quality,
                    sourceTimestamp: normalized.sourceMs === null ? null : formatInstant(normalized.sourceMs),
                    receivedTimestamp: formatInstant(normalized.receivedMs),
                    provider: normalized.provider,
                    time: formatInstant(normalized.timeMs),
                    timeOrigin: normalized.timeOrigin,
                },
            };
            let low = 0;
            let high = records.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (compareTimed(records[middle]!, record) < 0) low = middle + 1;
                else high = middle;
            }
            if (low < records.length && compareTimed(records[low]!, record) === 0) {
                duplicates++;
                return;
            }
            records.splice(low, 0, record);
            this._series.set(normalized.id, records);
            accepted++;
        });
        return { accepted, duplicates, rejected };
    }

    async readRawAsync(request: IReadRawRequest, signal?: AbortSignal): Promise<IReadRawResult> {
        this._enter(signal);
        const ids = parseIds(request.ids).map((path) => path.id);
        const { startMs, endMs } = parseRange(request.start, request.end);
        const limit = parseLimit(request.limit, this._capabilities.limits.maxPointsPerRead);

        // Resume after the last sample returned: index of its id, and its (time, received) key.
        let firstIndex = 0;
        let after: { timeMs: number; receivedMs: number } | undefined;
        if (request.continuationPoint !== undefined) {
            const state = decodeContinuation(request.continuationPoint);
            if (typeof state.i !== "number" || !Number.isInteger(state.i) || state.i < 0 || state.i >= ids.length) throw invalid("continuationPoint does not match these ids");
            firstIndex = state.i;
            if (typeof state.t === "number" && typeof state.r === "number") after = { timeMs: state.t, receivedMs: state.r };
        }

        const series: IRawSeries[] = [];
        let room = limit;
        for (let i = firstIndex; i < ids.length; i++) {
            const records = this._inRange(ids[i]!, startMs, endMs);
            const from = i === firstIndex && after ? records.findIndex((record) => compareTimed(record, after!) > 0) : 0;
            const pending = from < 0 ? [] : records.slice(from);
            const taken = pending.slice(0, room);
            series.push({ id: ids[i]!, samples: taken.map((record) => this._out(record)) });
            room -= taken.length;

            if (room === 0) {
                if (taken.length < pending.length) {
                    const last = taken[taken.length - 1]!;
                    return { series, continuationPoint: encodeContinuation({ i, t: last.timeMs, r: last.receivedMs }) };
                }
                // This id is complete; continue at the next one that still has samples.
                for (let next = i + 1; next < ids.length; next++) {
                    if (this._inRange(ids[next]!, startMs, endMs).length > 0) return { series, continuationPoint: encodeContinuation({ i: next }) };
                }
                return { series, continuationPoint: null };
            }
        }
        return { series, continuationPoint: null };
    }

    async readProcessedAsync(request: IReadProcessedRequest, signal?: AbortSignal): Promise<IReadProcessedResult> {
        this._enter(signal);
        const ids = parseIds(request.ids).map((path) => path.id);
        const { startMs, endMs } = parseRange(request.start, request.end);
        const intervalMs = checkBucketRequest(startMs, endMs, request.intervalMs, this._capabilities.limits.maxBucketsPerRead);
        const aggregates = parseAggregates(request.aggregates);

        const series: IProcessedSeries[] = ids.map((id) => {
            const records = this._series.get(id) ?? [];
            const first = lowerBound(records, startMs);
            const prior = first > 0 ? records[first - 1] : undefined;
            return { id, buckets: computeBuckets(this._inRange(id, startMs, endMs), prior, startMs, endMs, intervalMs, aggregates), computedBy: "store" };
        });
        return { series };
    }

    async readAtTimeAsync(request: IReadAtTimeRequest, signal?: AbortSignal): Promise<IReadAtTimeResult> {
        this._enter(signal);
        const ids = parseIds(request.ids).map((path) => path.id);
        const mode = parseAtTimeMode(request.mode);
        if (!Array.isArray(request.times) || request.times.length === 0) throw invalid("times must be a non-empty array of ISO 8601 instants");
        const times = request.times.map((time, index) => parseInstant(`times[${index}]`, time));
        const max = this._capabilities.limits.maxPointsPerRead;
        if (ids.length * times.length > max)
            throw new HistoryError("limit_exceeded", `${ids.length * times.length} values requested, the store maximum is ${max}`, { detail: { max } });

        const series: IAtTimeSeries[] = ids.map((id) => {
            const records = this._series.get(id) ?? [];
            return {
                id,
                values: times.map((timeMs) => {
                    const { before, after } = locate(records, timeMs);
                    const answer = valueAtTime(before, after, timeMs, mode);
                    return { time: formatInstant(timeMs), value: clone(answer.value), quality: answer.quality, basis: answer.basis };
                }),
            };
        });
        return { series };
    }

    async browseAsync(request: IHistoryBrowseRequest, signal?: AbortSignal): Promise<IHistoryBrowseResult> {
        this._enter(signal);
        const root = parseRoot(request.root);
        const limit = parseLimit(request.limit, this._capabilities.limits.maxBrowseItems);
        let afterId: string | undefined;
        if (request.continuationPoint !== undefined) {
            const state = decodeContinuation(request.continuationPoint);
            if (typeof state.after !== "string") throw invalid("continuationPoint is not one this store issued");
            afterId = state.after;
        }

        const ids = [...this._series.keys()]
            .filter((id) => !root || root.contains(UnsPath.parse(id)))
            .filter((id) => afterId === undefined || id > afterId)
            .sort();
        const items: IHistoryBrowseItem[] = ids.slice(0, limit).map((id) => {
            const records = this._series.get(id)!;
            return { id, first: records[0]!.sample.time, last: records[records.length - 1]!.sample.time, count: records.length };
        });
        const continuationPoint = ids.length > limit ? encodeContinuation({ after: items[items.length - 1]!.id }) : null;
        return { items, continuationPoint };
    }

    async deleteRangeAsync(request: IDeleteRangeRequest, signal?: AbortSignal): Promise<IDeleteRangeResult> {
        this._enter(signal);
        const ids = parseIds(request.ids).map((path) => path.id);
        const { startMs, endMs } = parseRange(request.start, request.end);
        let deleted = 0;
        for (const id of ids) {
            const records = this._series.get(id);
            if (!records) continue;
            const kept = records.filter((record) => record.timeMs < startMs || record.timeMs >= endMs);
            deleted += records.length - kept.length;
            if (kept.length === 0) this._series.delete(id);
            else this._series.set(id, kept);
        }
        return { deleted, errors: [] };
    }

    async closeAsync(): Promise<void> {
        this._closed = true;
        this._series.clear();
    }

    private _enter(signal: AbortSignal | undefined): void {
        signal?.throwIfAborted();
        if (this._closed) throw new HistoryError("store_unavailable", `history store "${this.id}" is closed`);
    }

    private _inRange(id: UnsId, startMs: number, endMs: number): IRecord[] {
        const records = this._series.get(id) ?? [];
        return records.slice(lowerBound(records, startMs), lowerBound(records, endMs));
    }

    private _out(record: IRecord): IStoredSample {
        return { ...record.sample, value: clone(record.sample.value) };
    }
}
