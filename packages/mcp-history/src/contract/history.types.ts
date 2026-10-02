import type { IHistoryErrorBody } from "./errors";
import type { UnsId } from "@cyanmycelium/mcp-uns";

export type Quality = "good" | "uncertain" | "bad";

/** Which timestamp a sample is filed under: its own, or the moment it was received when the protocol carries none. */
export type TimeOrigin = "source" | "received";

export const VALUE_TYPES = ["number", "boolean", "string", "json"] as const;
export type HistoryValueType = (typeof VALUE_TYPES)[number];

export const AGGREGATES = ["count", "min", "max", "avg", "sum", "first", "last", "timeWeightedAvg", "goodRatio"] as const;
export type Aggregate = (typeof AGGREGATES)[number];

export const AT_TIME_MODES = ["stepped", "interpolated"] as const;
export type AtTimeMode = (typeof AT_TIME_MODES)[number];

// ── Samples ─────────────────────────────────────────────────────────────────

/** One value to record: a SCADA v1 `IScadaValue`, flattened. */
export interface IHistorySample {
    readonly id: UnsId;
    readonly value: unknown;
    readonly quality: Quality;
    /** `null` when the protocol does not carry it. Never synthesized. */
    readonly sourceTimestamp: string | null;
    readonly receivedTimestamp: string;
    /** The SCADA provider the value came from. */
    readonly provider: string;
}

/** A recorded sample, as read back. Timestamps are normalized to ISO 8601 with milliseconds, in UTC. */
export interface IStoredSample extends IHistorySample {
    /** `sourceTimestamp ?? receivedTimestamp`: the time axis of the series. */
    readonly time: string;
    readonly timeOrigin: TimeOrigin;
}

/** An id the request named but that produced no data: refused, or unreachable behind a router. */
export interface ISeriesError {
    readonly id: UnsId;
    readonly error: IHistoryErrorBody;
}

export function isSeriesError(series: object): series is ISeriesError {
    return (series as ISeriesError).error !== undefined;
}

// ── append ──────────────────────────────────────────────────────────────────

export interface IRejectedSample {
    /** Position of the sample in the request. */
    readonly index: number;
    readonly error: IHistoryErrorBody;
}

export interface IAppendResult {
    readonly accepted: number;
    /** Samples already recorded under the same `(id, time, receivedTimestamp)`: ignored, not errors. */
    readonly duplicates: number;
    readonly rejected: readonly IRejectedSample[];
}

// ── read_raw ────────────────────────────────────────────────────────────────

export interface IReadRawRequest {
    readonly ids: readonly UnsId[];
    /** Inclusive. */
    readonly start: string;
    /** Exclusive. */
    readonly end: string;
    /** Samples per page, all ids together. Defaults to, and may not exceed, `limits.maxPointsPerRead`. */
    readonly limit?: number;
    /** Opaque, from the previous page of the same request. */
    readonly continuationPoint?: string;
}

export interface IRawSeries {
    readonly id: UnsId;
    /** Ordered by time, then by reception. */
    readonly samples: readonly IStoredSample[];
}

export interface IReadRawResult {
    /**
     * In the order of `ids`. A page carries a series for each id it reaches,
     * possibly empty; ids a previous page completed are not repeated.
     */
    readonly series: readonly (IRawSeries | ISeriesError)[];
    /** `null` on the last page. */
    readonly continuationPoint: string | null;
}

// ── read_processed ──────────────────────────────────────────────────────────

export interface IReadProcessedRequest {
    readonly ids: readonly UnsId[];
    readonly start: string;
    readonly end: string;
    /** Bucket width. The last bucket is cut at `end`. */
    readonly intervalMs: number;
    readonly aggregates: readonly Aggregate[];
}

export interface IBucket {
    readonly start: string;
    readonly end: string;
    /** One entry per requested aggregate; `null` when the bucket gives it no value. */
    readonly values: Readonly<Partial<Record<Aggregate, unknown>>>;
}

export interface IProcessedSeries {
    readonly id: UnsId;
    readonly buckets: readonly IBucket[];
    /** `store` when the backend computed the aggregates itself, `router` when a router computed them from raw reads. */
    readonly computedBy: "store" | "router";
}

export interface IReadProcessedResult {
    readonly series: readonly (IProcessedSeries | ISeriesError)[];
}

// ── read_at_time ────────────────────────────────────────────────────────────

export interface IReadAtTimeRequest {
    readonly ids: readonly UnsId[];
    /** Any order, duplicates allowed; answered in the same order. */
    readonly times: readonly string[];
    readonly mode: AtTimeMode;
}

/**
 * - `exact`: a sample sits at that time;
 * - `stepped`: the last sample before it, whatever its quality;
 * - `interpolated`: linear between the two usable numeric samples around it;
 * - `none`: nothing recorded before it.
 */
export type AtTimeBasis = "exact" | "stepped" | "interpolated" | "none";

export interface IAtTimeValue {
    readonly time: string;
    readonly value: unknown;
    readonly quality: Quality | null;
    readonly basis: AtTimeBasis;
}

export interface IAtTimeSeries {
    readonly id: UnsId;
    readonly values: readonly IAtTimeValue[];
}

export interface IReadAtTimeResult {
    readonly series: readonly (IAtTimeSeries | ISeriesError)[];
}

// ── browse ──────────────────────────────────────────────────────────────────

export interface IHistoryBrowseRequest {
    /** UNS subtree; matches by whole segments (`uns://a/b` covers `uns://a/b/c`, not `uns://a/bc`). */
    readonly root?: UnsId;
    /** Defaults to, and may not exceed, `limits.maxBrowseItems`. */
    readonly limit?: number;
    readonly continuationPoint?: string;
}

export interface IHistoryBrowseItem {
    readonly id: UnsId;
    readonly first: string;
    readonly last: string;
    readonly count: number;
}

export interface IHistoryBrowseResult {
    /** Ordered by id. */
    readonly items: readonly IHistoryBrowseItem[];
    readonly continuationPoint: string | null;
}

// ── delete_range ────────────────────────────────────────────────────────────

export interface IDeleteRangeRequest {
    readonly ids: readonly UnsId[];
    readonly start: string;
    readonly end: string;
}

export interface IDeleteRangeResult {
    readonly deleted: number;
    /** Ids refused or unreachable; the others were processed. */
    readonly errors: readonly ISeriesError[];
}

// ── Capabilities ────────────────────────────────────────────────────────────

export interface IHistoryCapabilities {
    readonly interface: "history.v1";
    /** Backend kind: `memory`, `sqlite`, `duckdb`, `mysql`, `router`, ... */
    readonly store: string;
    readonly valueTypes: readonly HistoryValueType[];
    /** Aggregates the backend computes itself. The others are computed by a router, from raw reads. */
    readonly nativeAggregates: readonly Aggregate[];
    readonly operations: { readonly delete: boolean };
    readonly retention: { readonly maxAgeMs: number | null };
    readonly durability: "memory" | "local-disk" | "server";
    readonly limits: {
        readonly maxSamplesPerAppend: number;
        /** Raw samples per page; also bounds `ids × times` for `read_at_time`. */
        readonly maxPointsPerRead: number;
        /** Buckets per id for `read_processed`. */
        readonly maxBucketsPerRead: number;
        readonly maxBrowseItems: number;
    };
}
