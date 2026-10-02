import { HistoryError } from "./errors";
import type { Aggregate, AtTimeBasis, AtTimeMode, IBucket, Quality } from "./history.types";
import { formatInstant } from "./validation";

/** The part of a sample that aggregation and at-time reads look at. */
export interface ITimedValue {
    readonly timeMs: number;
    readonly receivedMs: number;
    readonly value: unknown;
    readonly quality: Quality;
}

/** Orders samples the way every read returns them: by time, then by reception. */
export function compareTimed(a: Pick<ITimedValue, "timeMs" | "receivedMs">, b: Pick<ITimedValue, "timeMs" | "receivedMs">): number {
    return a.timeMs - b.timeMs || a.receivedMs - b.receivedMs;
}

/** `bad` samples are recorded and read back raw, but they carry no usable value. */
export function isUsable(point: ITimedValue): boolean {
    return point.quality !== "bad";
}

/** The numeric reading of a value for aggregation: numbers as they are, booleans as 0 and 1, anything else none. */
export function numericOf(value: unknown): number | undefined {
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (typeof value === "boolean") return value ? 1 : 0;
    return undefined;
}

export function bucketCount(startMs: number, endMs: number, intervalMs: number): number {
    return Math.ceil((endMs - startMs) / intervalMs);
}

export function checkBucketRequest(startMs: number, endMs: number, intervalMs: unknown, maxBuckets: number): number {
    if (typeof intervalMs !== "number" || !Number.isInteger(intervalMs) || intervalMs < 1) {
        throw new HistoryError("invalid_request", "intervalMs must be a positive integer");
    }
    const count = bucketCount(startMs, endMs, intervalMs);
    if (count > maxBuckets) {
        throw new HistoryError("limit_exceeded", `${count} buckets requested, the store maximum is ${maxBuckets}`, { detail: { max: maxBuckets } });
    }
    return intervalMs;
}

/**
 * The reference semantics of `read_processed`, for one id.
 *
 * - Buckets are `[start + k·interval, start + (k+1)·interval)`, the last one cut at `end`.
 * - `bad` samples count only in `goodRatio`. Every other aggregate ignores them.
 * - `count`: usable samples. `first`, `last`: usable values, of any type.
 * - `min`, `max`, `sum`, `avg`: usable numeric values (booleans as 0 and 1).
 * - `timeWeightedAvg`: each numeric value holds until the next sample (stepped),
 *   starting from `prior`, the last sample before `start`. A `bad` or
 *   non-numeric sample makes the value unknown until the next one; unknown
 *   time is left out of the average.
 * - `goodRatio`: `good` samples over all samples of the bucket.
 * - An aggregate with nothing to work on is `null`.
 *
 * A backend may compute natively; it must give the same results, which the
 * conformance suite checks.
 *
 * @param points the samples of `[startMs, endMs)`, ordered by {@link compareTimed}
 * @param prior the last sample before `startMs`, if any
 */
export function computeBuckets(
    points: readonly ITimedValue[],
    prior: ITimedValue | undefined,
    startMs: number,
    endMs: number,
    intervalMs: number,
    aggregates: readonly Aggregate[]
): IBucket[] {
    const buckets: IBucket[] = [];
    let held: number | undefined = prior && isUsable(prior) ? numericOf(prior.value) : undefined;
    let index = 0;

    for (let bucketStart = startMs; bucketStart < endMs; bucketStart += intervalMs) {
        const bucketEnd = Math.min(bucketStart + intervalMs, endMs);
        const inBucket: ITimedValue[] = [];
        while (index < points.length && points[index]!.timeMs < bucketEnd) {
            if (points[index]!.timeMs >= bucketStart) inBucket.push(points[index]!);
            index++;
        }

        // Stepped integral over the bucket.
        let area = 0;
        let covered = 0;
        let cursor = bucketStart;
        for (const point of inBucket) {
            if (held !== undefined) {
                area += held * (point.timeMs - cursor);
                covered += point.timeMs - cursor;
            }
            cursor = point.timeMs;
            held = isUsable(point) ? numericOf(point.value) : undefined;
        }
        if (held !== undefined) {
            area += held * (bucketEnd - cursor);
            covered += bucketEnd - cursor;
        }

        const usable = inBucket.filter(isUsable);
        const numbers = usable.map((point) => numericOf(point.value)).filter((value): value is number => value !== undefined);
        const sum = numbers.reduce((total, value) => total + value, 0);
        const values: Partial<Record<Aggregate, unknown>> = {};
        for (const aggregate of aggregates) {
            switch (aggregate) {
                case "count":
                    values.count = usable.length;
                    break;
                case "min":
                    values.min = numbers.length ? Math.min(...numbers) : null;
                    break;
                case "max":
                    values.max = numbers.length ? Math.max(...numbers) : null;
                    break;
                case "sum":
                    values.sum = numbers.length ? sum : null;
                    break;
                case "avg":
                    values.avg = numbers.length ? sum / numbers.length : null;
                    break;
                case "first":
                    values.first = usable.length ? usable[0]!.value : null;
                    break;
                case "last":
                    values.last = usable.length ? usable[usable.length - 1]!.value : null;
                    break;
                case "timeWeightedAvg":
                    values.timeWeightedAvg = covered > 0 ? area / covered : null;
                    break;
                case "goodRatio":
                    values.goodRatio = inBucket.length ? inBucket.filter((point) => point.quality === "good").length / inBucket.length : null;
                    break;
            }
        }
        buckets.push({ start: formatInstant(bucketStart), end: formatInstant(bucketEnd), values });
    }
    return buckets;
}

const QUALITY_RANK: Record<Quality, number> = { good: 0, uncertain: 1, bad: 2 };

function worst(a: Quality, b: Quality): Quality {
    return QUALITY_RANK[a] >= QUALITY_RANK[b] ? a : b;
}

/**
 * The reference semantics of `read_at_time`, for one id and one instant.
 *
 * - A sample at that very time answers `exact` (the last received, if several).
 * - `stepped`: the last sample before, with its quality, even `bad`.
 * - `interpolated`: linear between the samples before and after when both are
 *   usable numbers (not booleans), with the worse of their two qualities;
 *   otherwise it falls back to `stepped`. Nothing is extrapolated.
 * - Nothing before: `none`, value and quality `null`.
 *
 * @param before the last sample at or before `timeMs`
 * @param after the first sample after `timeMs`
 */
export function valueAtTime(
    before: ITimedValue | undefined,
    after: ITimedValue | undefined,
    timeMs: number,
    mode: AtTimeMode
): { value: unknown; quality: Quality | null; basis: AtTimeBasis } {
    if (!before) return { value: null, quality: null, basis: "none" };
    if (before.timeMs === timeMs) return { value: before.value, quality: before.quality, basis: "exact" };
    if (
        mode === "interpolated" &&
        after &&
        isUsable(before) &&
        isUsable(after) &&
        typeof before.value === "number" &&
        typeof after.value === "number" &&
        after.timeMs > before.timeMs
    ) {
        const ratio = (timeMs - before.timeMs) / (after.timeMs - before.timeMs);
        return { value: before.value + (after.value - before.value) * ratio, quality: worst(before.quality, after.quality), basis: "interpolated" };
    }
    return { value: before.value, quality: before.quality, basis: "stepped" };
}

/**
 * Finds, in points ordered by {@link compareTimed}, the last one at or before
 * `timeMs` and the first one after it.
 */
export function locate<T extends ITimedValue>(points: readonly T[], timeMs: number): { before: T | undefined; after: T | undefined } {
    let low = 0;
    let high = points.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (points[middle]!.timeMs <= timeMs) low = middle + 1;
        else high = middle;
    }
    return { before: low > 0 ? points[low - 1] : undefined, after: points[low] };
}
