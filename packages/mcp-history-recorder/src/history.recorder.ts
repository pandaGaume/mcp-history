import { HistoryError, type IHistorySample, type IHistoryStore, type Quality } from "@cyanmycelium/mcp-history";
import type { UnsId } from "@cyanmycelium/mcp-uns";
import { MemoryRecorderBuffer, type IRecorderBuffer } from "./recorder.buffer";
import { isScadaReadError, type IScadaReader, type ScadaReadItem } from "./scada.reader";

export interface IRecordedTag {
    readonly id: UnsId;
    /** How often the value is read. */
    readonly periodMs: number;
    /**
     * - `periodic` (default): every read is recorded;
     * - `on-change`: a read is recorded when its quality changes, or its value
     *   moves beyond `deadband` (numbers) or differs (anything else).
     */
    readonly mode?: "periodic" | "on-change";
    /** `on-change`, numbers: the smallest move worth a sample. Default 0: any move. */
    readonly deadband?: number;
    /** `on-change`: record anyway after this long without a sample, so a flat value still shows it is alive. */
    readonly maxSilenceMs?: number;
}

/**
 * SCADA errors that say nothing about the process, so nothing is recorded:
 * "not yours" or "not a resource" (refusals, a bad request), and "not now"
 * (`rate_limited`: mcp-scada protecting the equipment from too many reads;
 * `cache_miss`: a `local` read with nothing cached). The next read tries again.
 */
const NOT_A_PROCESS_STATE: ReadonlySet<string> = new Set([
    "policy_denied",
    "authorization_unavailable",
    "approval_required",
    "invalid_request",
    "unknown_resource",
    "unsupported_capability",
    "unsupported_destination",
    "unsupported_consistency",
    "rate_limited",
    "cache_miss",
]);

export type RecorderEvent =
    | { readonly type: "read-failed"; readonly ids: readonly UnsId[]; readonly reason: string }
    | { readonly type: "read-refused"; readonly id: UnsId; readonly code: string }
    | { readonly type: "read-error"; readonly id: UnsId; readonly code: string; readonly message: string }
    | { readonly type: "flush-failed"; readonly reason: string; readonly retryInMs: number }
    | { readonly type: "samples-rejected"; readonly count: number; readonly codes: readonly string[] };

export interface IHistoryRecorderOptions {
    readonly reader: IScadaReader;
    /** Where samples end up: a `HistorySlotStore` on the `history` slot, or a store in process. */
    readonly sink: IHistoryStore;
    /** Store-and-forward queue. Default: in memory. A `SqliteRecorderBuffer` survives a restart. */
    readonly buffer?: IRecorderBuffer;
    readonly tags: readonly IRecordedTag[];
    /** How often the buffer is drained toward the sink. Default 1 s. */
    readonly flushIntervalMs?: number;
    /** Samples per `append`. Default 500; halved on `limit_exceeded`. */
    readonly maxBatch?: number;
    /** Ceiling of the retry delay while the sink is unreachable. Default 30 s. */
    readonly retryMaxMs?: number;
    /**
     * Record a failed read (device or slot unreachable) as a `bad` sample with
     * a `null` value, timestamped at reception. Default `true`: an outage is
     * part of the process history. Refusals (`policy_denied`...) never are.
     */
    readonly recordReadFailures?: boolean;
    /** `provider` of the samples the recorder writes itself, for read failures. Default `recorder`. */
    readonly providerName?: string;
    readonly onEvent?: (event: RecorderEvent) => void;
    /** Clock, for tests. */
    readonly now?: () => number;
}

export interface IRecorderStats {
    readonly reads: number;
    readonly readFailures: number;
    readonly recorded: number;
    readonly appended: number;
    readonly duplicates: number;
    readonly rejected: number;
    /** Dropped by a full buffer. */
    readonly dropped: number;
    readonly buffered: number;
    readonly lastFlushError: string | null;
}

interface ILast {
    readonly value: unknown;
    readonly quality: Quality;
    readonly at: number;
}

function sameValue(a: unknown, b: unknown, deadband: number): boolean {
    if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= deadband;
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Feeds the history from SCADA: reads tags on their period, decides what is
 * worth a sample, and forwards samples to the history through a
 * store-and-forward buffer.
 *
 * Every sample goes through the buffer first, so a history slot that is down
 * costs nothing but delay: the buffer is replayed when it comes back, and
 * `history.append` being idempotent, a replay never duplicates a sample.
 *
 * `pollAsync` and `flushAsync` can be driven by hand (tests, a scheduler of
 * one's own); `start` drives them with timers.
 */
export class HistoryRecorder {
    private readonly _reader: IScadaReader;
    private readonly _sink: IHistoryStore;
    private readonly _buffer: IRecorderBuffer;
    private readonly _tags: ReadonlyMap<UnsId, IRecordedTag>;
    private readonly _flushIntervalMs: number;
    private readonly _retryMaxMs: number;
    private readonly _recordFailures: boolean;
    private readonly _providerName: string;
    private readonly _onEvent: (event: RecorderEvent) => void;
    private readonly _now: () => number;
    private readonly _last = new Map<UnsId, ILast>();
    private readonly _timers: ReturnType<typeof setInterval>[] = [];
    private readonly _polling = new Set<number>();
    private _maxBatch: number;
    private _flushing: Promise<unknown> | undefined;
    private _failures = 0;
    private _nextFlushAt = 0;
    private _stats = { reads: 0, readFailures: 0, recorded: 0, appended: 0, duplicates: 0, rejected: 0 };
    private _lastFlushError: string | null = null;

    constructor(options: IHistoryRecorderOptions) {
        if (options.tags.length === 0) throw new Error("HistoryRecorder: no tag to record");
        const tags = new Map<UnsId, IRecordedTag>();
        for (const tag of options.tags) {
            if (tags.has(tag.id)) throw new Error(`HistoryRecorder: ${tag.id} is listed twice`);
            if (!(tag.periodMs > 0)) throw new Error(`HistoryRecorder: ${tag.id} needs a positive periodMs`);
            tags.set(tag.id, tag);
        }
        this._reader = options.reader;
        this._sink = options.sink;
        this._buffer = options.buffer ?? new MemoryRecorderBuffer();
        this._tags = tags;
        this._flushIntervalMs = options.flushIntervalMs ?? 1_000;
        this._maxBatch = options.maxBatch ?? 500;
        this._retryMaxMs = options.retryMaxMs ?? 30_000;
        this._recordFailures = options.recordReadFailures ?? true;
        this._providerName = options.providerName ?? "recorder";
        this._onEvent = options.onEvent ?? (() => {});
        this._now = options.now ?? Date.now;
    }

    /** Starts one timer per distinct period, and the flush timer. */
    start(): void {
        if (this._timers.length > 0) return;
        for (const periodMs of new Set([...this._tags.values()].map((tag) => tag.periodMs))) {
            this._timers.push(setInterval(() => void this.pollAsync(periodMs), periodMs));
        }
        this._timers.push(setInterval(() => void this.flushAsync(), this._flushIntervalMs));
    }

    /** Stops the timers, then makes a last attempt to empty the buffer. */
    async stopAsync(): Promise<void> {
        for (const timer of this._timers.splice(0)) clearInterval(timer);
        await this._flushing;
        await this.flushAsync({ force: true });
    }

    /**
     * Reads the tags of one period (every tag when omitted), and buffers the
     * samples worth keeping. A poll still running for that period is not
     * overlapped: the tick is skipped. Returns the number of samples buffered.
     */
    async pollAsync(periodMs?: number): Promise<number> {
        const key = periodMs ?? -1;
        if (this._polling.has(key)) return 0;
        this._polling.add(key);
        try {
            const ids = [...this._tags.values()].filter((tag) => periodMs === undefined || tag.periodMs === periodMs).map((tag) => tag.id);
            if (ids.length === 0) return 0;
            let items: ScadaReadItem[];
            try {
                items = await this._reader.readAsync(ids);
                this._stats.reads++;
            } catch (error) {
                this._stats.readFailures++;
                const reason = error instanceof Error ? error.message : String(error);
                this._onEvent({ type: "read-failed", ids, reason });
                items = ids.map((id) => ({ id, error: { code: "provider_unavailable", message: reason } }));
            }
            const samples: IHistorySample[] = [];
            for (const item of items) {
                const sample = this._sampleOf(item);
                if (sample) samples.push(sample);
            }
            if (samples.length > 0) {
                await this._buffer.pushAsync(samples);
                this._stats.recorded += samples.length;
            }
            return samples.length;
        } finally {
            this._polling.delete(key);
        }
    }

    /**
     * Drains the buffer toward the sink, oldest first, until it is empty or the
     * sink fails. While the sink is unreachable, attempts back off up to
     * `retryMaxMs`; `force` ignores the back-off.
     */
    async flushAsync(options: { force?: boolean } = {}): Promise<{ appended: number; duplicates: number; rejected: number }> {
        if (this._flushing) {
            await this._flushing;
            return { appended: 0, duplicates: 0, rejected: 0 };
        }
        if (!options.force && this._now() < this._nextFlushAt) return { appended: 0, duplicates: 0, rejected: 0 };
        const run = this._drainAsync();
        this._flushing = run;
        try {
            return await run;
        } finally {
            this._flushing = undefined;
        }
    }

    async statsAsync(): Promise<IRecorderStats> {
        return { ...this._stats, dropped: this._buffer.dropped, buffered: await this._buffer.sizeAsync(), lastFlushError: this._lastFlushError };
    }

    /** Stops, then closes the buffer. The sink belongs to whoever created it. */
    async closeAsync(): Promise<void> {
        await this.stopAsync();
        await this._buffer.closeAsync();
    }

    private async _drainAsync(): Promise<{ appended: number; duplicates: number; rejected: number }> {
        const total = { appended: 0, duplicates: 0, rejected: 0 };
        for (;;) {
            const batch = await this._buffer.peekAsync(this._maxBatch);
            if (batch.length === 0) break;
            let result;
            try {
                result = await this._sink.appendAsync(batch.map((entry) => entry.sample));
            } catch (error) {
                if (error instanceof HistoryError && error.code === "limit_exceeded" && this._maxBatch > 1) {
                    this._maxBatch = Math.max(1, Math.floor(this._maxBatch / 2));
                    continue;
                }
                if (error instanceof HistoryError && error.code === "invalid_request") {
                    // A batch the sink will never take: drop it rather than block the queue behind it.
                    await this._buffer.ackAsync(batch[batch.length - 1]!.seq);
                    total.rejected += batch.length;
                    this._stats.rejected += batch.length;
                    this._onEvent({ type: "samples-rejected", count: batch.length, codes: ["invalid_request"] });
                    continue;
                }
                this._failures++;
                const retryInMs = Math.min(this._retryMaxMs, this._flushIntervalMs * 2 ** (this._failures - 1));
                this._nextFlushAt = this._now() + retryInMs;
                this._lastFlushError = error instanceof Error ? error.message : String(error);
                this._onEvent({ type: "flush-failed", reason: this._lastFlushError, retryInMs });
                return total;
            }
            await this._buffer.ackAsync(batch[batch.length - 1]!.seq);
            this._failures = 0;
            this._nextFlushAt = 0;
            this._lastFlushError = null;
            total.appended += result.accepted;
            total.duplicates += result.duplicates;
            total.rejected += result.rejected.length;
            this._stats.appended += result.accepted;
            this._stats.duplicates += result.duplicates;
            this._stats.rejected += result.rejected.length;
            if (result.rejected.length > 0) {
                this._onEvent({ type: "samples-rejected", count: result.rejected.length, codes: [...new Set(result.rejected.map((item) => item.error.code))] });
            }
        }
        return total;
    }

    /** The sample a read item is worth, or nothing. */
    private _sampleOf(item: ScadaReadItem): IHistorySample | undefined {
        const tag = this._tags.get(item.id);
        if (!tag) return undefined;
        const now = this._now();
        let sample: IHistorySample;
        if (isScadaReadError(item)) {
            if (NOT_A_PROCESS_STATE.has(item.error.code)) {
                this._onEvent({ type: "read-refused", id: item.id, code: item.error.code });
                return undefined;
            }
            this._onEvent({ type: "read-error", id: item.id, code: item.error.code, message: item.error.message });
            if (!this._recordFailures) return undefined;
            sample = { id: item.id, value: null, quality: "bad", sourceTimestamp: null, receivedTimestamp: new Date(now).toISOString(), provider: this._providerName };
        } else {
            sample = {
                id: item.id,
                value: item.value,
                quality: item.quality,
                sourceTimestamp: item.sourceTimestamp,
                receivedTimestamp: item.receivedTimestamp,
                provider: item.provenance.provider,
            };
        }

        if (tag.mode === "on-change") {
            const last = this._last.get(tag.id);
            const silent = last !== undefined && tag.maxSilenceMs !== undefined && now - last.at >= tag.maxSilenceMs;
            const changed = !last || last.quality !== sample.quality || !sameValue(last.value, sample.value, tag.deadband ?? 0);
            if (!changed && !silent) return undefined;
        }
        this._last.set(tag.id, { value: sample.value, quality: sample.quality, at: now });
        return sample;
    }
}
