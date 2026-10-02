import { HistoryError, invalid, type IHistoryErrorBody } from "./errors";
import {
    AGGREGATES,
    AT_TIME_MODES,
    READ_FORMATS,
    type Aggregate,
    type ReadFormat,
    type HistoryValueType,
    type IHistoryCapabilities,
    type IHistorySample,
    type Quality,
    type TimeOrigin,
} from "./history.types";
import { UnsPath, type UnsId } from "@cyanmycelium/mcp-uns";

const QUALITIES: readonly Quality[] = ["good", "uncertain", "bad"];

/** ISO 8601 with a date, a time and an explicit offset: a local time would be read differently by each store. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Parses an ISO 8601 instant to epoch milliseconds, or returns `undefined`. */
export function tryParseInstant(value: unknown): number | undefined {
    if (typeof value !== "string" || !ISO_INSTANT.test(value)) return undefined;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
}

export function parseInstant(name: string, value: unknown): number {
    const ms = tryParseInstant(value);
    if (ms === undefined) throw invalid(`${name} must be an ISO 8601 instant with an offset, e.g. 2026-10-02T08:00:00.000Z (got ${JSON.stringify(value)})`);
    return ms;
}

export function formatInstant(ms: number): string {
    return new Date(ms).toISOString();
}

/** Validates `[start, end)` and returns it in epoch milliseconds. */
export function parseRange(start: unknown, end: unknown): { startMs: number; endMs: number } {
    const startMs = parseInstant("start", start);
    const endMs = parseInstant("end", end);
    if (endMs <= startMs) throw invalid("end must be after start");
    return { startMs, endMs };
}

/** Validates a list of ids: non-empty, canonical UNS ids, no duplicates. Returns the parsed paths. */
export function parseIds(ids: unknown): UnsPath[] {
    if (!Array.isArray(ids) || ids.length === 0) throw invalid("ids must be a non-empty array of UNS ids");
    const seen = new Set<string>();
    return ids.map((id) => {
        const path = UnsPath.tryParse(id as UnsId);
        if (!path || path.id !== id) throw invalid(`"${String(id)}" is not a canonical UNS id`);
        if (seen.has(path.id)) throw invalid(`${path.id} appears twice in ids`);
        seen.add(path.id);
        return path;
    });
}

export function parseRoot(root: unknown): UnsPath | undefined {
    if (root === undefined) return undefined;
    const path = UnsPath.tryParse(root as UnsId);
    if (!path || path.id !== root) throw invalid(`root "${String(root)}" is not a canonical UNS id`);
    return path;
}

/** Applies the default and the ceiling of a page size. */
export function parseLimit(limit: unknown, max: number): number {
    if (limit === undefined) return max;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) throw invalid("limit must be a positive integer");
    if (limit > max) throw new HistoryError("limit_exceeded", `limit ${limit} exceeds the store maximum of ${max}`, { detail: { max } });
    return limit;
}

export function parseAggregates(aggregates: unknown): Aggregate[] {
    if (!Array.isArray(aggregates) || aggregates.length === 0) throw invalid("aggregates must be a non-empty array");
    for (const aggregate of aggregates) {
        if (!AGGREGATES.includes(aggregate as Aggregate)) throw invalid(`unknown aggregate "${String(aggregate)}"; expected one of ${AGGREGATES.join(", ")}`);
    }
    return [...new Set(aggregates as Aggregate[])];
}

export function parseFormat(format: unknown): ReadFormat {
    if (format === undefined) return "rows";
    if (!READ_FORMATS.includes(format as ReadFormat)) throw invalid(`format must be one of ${READ_FORMATS.join(", ")}`);
    return format as ReadFormat;
}

export function parseAtTimeMode(mode: unknown): (typeof AT_TIME_MODES)[number] {
    if (!AT_TIME_MODES.includes(mode as (typeof AT_TIME_MODES)[number])) throw invalid(`mode must be one of ${AT_TIME_MODES.join(", ")}`);
    return mode as (typeof AT_TIME_MODES)[number];
}

/** The type a value is stored as, or `undefined` for a value no store accepts (NaN, Infinity, undefined, a function...). */
export function valueTypeOf(value: unknown): HistoryValueType | undefined {
    switch (typeof value) {
        case "number":
            return Number.isFinite(value) ? "number" : undefined;
        case "boolean":
            return "boolean";
        case "string":
            return "string";
        case "object":
            return isJson(value) ? "json" : undefined;
        default:
            return undefined;
    }
}

function isJson(value: unknown, depth = 0): boolean {
    if (depth > 64) return false;
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
    if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return Object.values(value).every((item) => isJson(item, depth + 1));
    return false;
}

/** A sample checked and reduced to what a store files it under. */
export interface INormalizedSample {
    readonly id: UnsId;
    readonly timeMs: number;
    readonly receivedMs: number;
    readonly timeOrigin: TimeOrigin;
    readonly sourceMs: number | null;
    readonly value: unknown;
    readonly valueType: HistoryValueType;
    readonly quality: Quality;
    readonly provider: string;
}

/** Checks one sample against the contract and the store's capabilities. Returns the error body instead of throwing: one bad sample never fails an append. */
export function normalizeSample(sample: unknown, capabilities: Pick<IHistoryCapabilities, "valueTypes">): INormalizedSample | IHistoryErrorBody {
    if (typeof sample !== "object" || sample === null) return invalid("a sample must be an object").toBody();
    const s = sample as Partial<IHistorySample>;
    const path = UnsPath.tryParse(s.id as UnsId);
    if (!path || path.id !== s.id) return invalid(`"${String(s.id)}" is not a canonical UNS id`).toBody();
    if (!QUALITIES.includes(s.quality as Quality)) return invalid(`quality must be one of ${QUALITIES.join(", ")}`).toBody();
    if (typeof s.provider !== "string" || s.provider.length === 0) return invalid("provider must be a non-empty string").toBody();
    const receivedMs = tryParseInstant(s.receivedTimestamp);
    if (receivedMs === undefined) return invalid("receivedTimestamp must be an ISO 8601 instant with an offset").toBody();
    let sourceMs: number | null = null;
    if (s.sourceTimestamp !== null) {
        const parsed = tryParseInstant(s.sourceTimestamp);
        if (parsed === undefined) return invalid("sourceTimestamp must be null or an ISO 8601 instant with an offset").toBody();
        sourceMs = parsed;
    }
    const valueType = valueTypeOf(s.value);
    if (!valueType) return invalid("value must be a finite number, a boolean, a string or a JSON value").toBody();
    if (!capabilities.valueTypes.includes(valueType)) {
        return new HistoryError("unsupported_value_type", `this store does not record ${valueType} values`, { detail: { valueTypes: capabilities.valueTypes } }).toBody();
    }
    return {
        id: path.id,
        timeMs: sourceMs ?? receivedMs,
        receivedMs,
        timeOrigin: sourceMs === null ? "received" : "source",
        sourceMs,
        value: s.value,
        valueType,
        quality: s.quality as Quality,
        provider: s.provider,
    };
}

export function isNormalizedSample(value: INormalizedSample | IHistoryErrorBody): value is INormalizedSample {
    return (value as INormalizedSample).timeMs !== undefined;
}
