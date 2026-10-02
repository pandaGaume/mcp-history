import Database from "better-sqlite3";
import {
    AGGREGATES,
    HistoryError,
    VALUE_TYPES,
    checkBucketRequest,
    computeBuckets,
    decodeContinuation,
    encodeContinuation,
    formatInstant,
    formatProcessedSeries,
    formatRawSeries,
    invalid,
    isNormalizedSample,
    normalizeSample,
    parseAggregates,
    parseAtTimeMode,
    parseFormat,
    parseIds,
    parseInstant,
    parseLimit,
    parseRange,
    parseRoot,
    valueAtTime,
    type Aggregate,
    type HistoryValueType,
    type IAppendResult,
    type IAtTimeSeries,
    type IBucket,
    type IDeleteRangeRequest,
    type IDeleteRangeResult,
    type IHistoryBrowseRequest,
    type IHistoryBrowseResult,
    type IHistoryCapabilities,
    type IHistorySample,
    type IHistoryStore,
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
    type ITimedValue,
    type Quality,
} from "@cyanmycelium/mcp-history";

/** Bumped when the table layout changes; a file written by another layout is refused, never guessed at. */
const SCHEMA_VERSION = 1;

/**
 * One table, readable as is by any SQL tool (a Grafana SQLite datasource
 * included). The primary key is what makes `append` idempotent, and what every
 * read walks: by id, then by time, then by reception.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS history_samples (
    id          TEXT    NOT NULL,
    t_ms        INTEGER NOT NULL,
    received_ms INTEGER NOT NULL,
    source_ms   INTEGER,
    value_type  TEXT    NOT NULL CHECK (value_type IN ('n', 'b', 's', 'j')),
    value_num   REAL,
    value_text  TEXT,
    quality     TEXT    NOT NULL CHECK (quality IN ('g', 'u', 'b')),
    provider    TEXT    NOT NULL,
    PRIMARY KEY (id, t_ms, received_ms)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS history_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;
`;

const TYPE_CODE: Record<HistoryValueType, string> = { number: "n", boolean: "b", string: "s", json: "j" };
const QUALITY_CODE: Record<Quality, string> = { good: "g", uncertain: "u", bad: "b" };
const QUALITY_OF: Record<string, Quality> = { g: "good", u: "uncertain", b: "bad" };

/** The aggregates SQLite computes in one GROUP BY; the others come from the contract's reference semantics over the rows. */
const SQL_AGGREGATES: ReadonlySet<Aggregate> = new Set(["count", "min", "max", "sum", "avg", "goodRatio"]);

interface IRow {
    readonly id: string;
    readonly t_ms: number;
    readonly received_ms: number;
    readonly source_ms: number | null;
    readonly value_type: string;
    readonly value_num: number | null;
    readonly value_text: string | null;
    readonly quality: string;
    readonly provider: string;
}

interface ITimedRow extends ITimedValue {
    readonly row: IRow;
}

export interface ISqliteHistoryStoreOptions {
    readonly id?: string;
    /** A file path, or `":memory:"` for a store that lives as long as the process. */
    readonly path: string;
    readonly limits?: Partial<IHistoryCapabilities["limits"]>;
}

const DEFAULT_LIMITS: IHistoryCapabilities["limits"] = {
    maxSamplesPerAppend: 10_000,
    maxPointsPerRead: 10_000,
    maxBucketsPerRead: 10_000,
    maxBrowseItems: 1_000,
};

function valueOf(row: IRow): unknown {
    switch (row.value_type) {
        case "n":
            return row.value_num;
        case "b":
            return row.value_num !== 0;
        case "s":
            return row.value_text;
        default:
            return JSON.parse(row.value_text ?? "null") as unknown;
    }
}

function timed(row: IRow): ITimedRow {
    return { timeMs: row.t_ms, receivedMs: row.received_ms, value: valueOf(row), quality: QUALITY_OF[row.quality]!, row };
}

function sampleOf(row: IRow): IStoredSample {
    return {
        id: row.id,
        value: valueOf(row),
        quality: QUALITY_OF[row.quality]!,
        sourceTimestamp: row.source_ms === null ? null : formatInstant(row.source_ms),
        receivedTimestamp: formatInstant(row.received_ms),
        provider: row.provider,
        time: formatInstant(row.t_ms),
        timeOrigin: row.source_ms === null ? "received" : "source",
    };
}

/**
 * history.v1 on SQLite: one local file, every value type, every aggregate,
 * delete supported.
 *
 * `count`, `min`, `max`, `sum`, `avg` and `goodRatio` are computed by SQLite
 * in one `GROUP BY` per id; `first`, `last` and `timeWeightedAvg` by the
 * contract's reference functions over the rows, only when they are asked for.
 * Either way the store computes them itself (`computedBy: "store"`), and the
 * conformance suite holds both paths to the same results.
 *
 * The file is opened in WAL mode: readers never wait for the writer.
 */
export class SqliteHistoryStore implements IHistoryStore {
    readonly id: string;
    private readonly _db: Database.Database;
    private readonly _capabilities: IHistoryCapabilities;
    private _closed = false;

    constructor(options: ISqliteHistoryStoreOptions) {
        this.id = options.id ?? "sqlite";
        const inMemory = options.path === ":memory:";
        this._db = new Database(options.path);
        if (!inMemory) {
            this._db.pragma("journal_mode = WAL");
            this._db.pragma("synchronous = NORMAL");
        }
        this._db.exec(SCHEMA);
        this._checkSchemaVersion();
        this._capabilities = {
            interface: "history.v1",
            store: "sqlite",
            valueTypes: [...VALUE_TYPES],
            nativeAggregates: [...AGGREGATES],
            operations: { delete: true },
            retention: { maxAgeMs: null },
            durability: inMemory ? "memory" : "local-disk",
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

        const insert = this._db.prepare(
            `INSERT OR IGNORE INTO history_samples (id, t_ms, received_ms, source_ms, value_type, value_num, value_text, quality, provider)
             VALUES (@id, @t_ms, @received_ms, @source_ms, @value_type, @value_num, @value_text, @quality, @provider)`
        );
        let accepted = 0;
        let duplicates = 0;
        const rejected: IRejectedSample[] = [];
        // One transaction: an append is one disk sync, however many samples it carries.
        this._db.transaction(() => {
            samples.forEach((sample, index) => {
                const normalized = normalizeSample(sample, this._capabilities);
                if (!isNormalizedSample(normalized)) {
                    rejected.push({ index, error: normalized });
                    return;
                }
                const numeric = normalized.valueType === "number" || normalized.valueType === "boolean";
                const { changes } = insert.run({
                    id: normalized.id,
                    t_ms: normalized.timeMs,
                    received_ms: normalized.receivedMs,
                    source_ms: normalized.sourceMs,
                    value_type: TYPE_CODE[normalized.valueType],
                    value_num: numeric ? Number(normalized.value) : null,
                    value_text: normalized.valueType === "string" ? (normalized.value as string) : normalized.valueType === "json" ? JSON.stringify(normalized.value) : null,
                    quality: QUALITY_CODE[normalized.quality],
                    provider: normalized.provider,
                });
                if (changes > 0) accepted++;
                else duplicates++;
            });
        })();
        return { accepted, duplicates, rejected };
    }

    async readRawAsync(request: IReadRawRequest, signal?: AbortSignal): Promise<IReadRawResult> {
        this._enter(signal);
        const ids = parseIds(request.ids).map((path) => path.id);
        const { startMs, endMs } = parseRange(request.start, request.end);
        const limit = parseLimit(request.limit, this._capabilities.limits.maxPointsPerRead);
        const format = parseFormat(request.format);
        const page = (series: IRawSeries[], continuationPoint: string | null): IReadRawResult => ({ format, series: formatRawSeries(series, format), continuationPoint });

        let firstIndex = 0;
        let after: { t: number; r: number } | undefined;
        if (request.continuationPoint !== undefined) {
            const state = decodeContinuation(request.continuationPoint);
            if (typeof state.i !== "number" || !Number.isInteger(state.i) || state.i < 0 || state.i >= ids.length) throw invalid("continuationPoint does not match these ids");
            firstIndex = state.i;
            if (typeof state.t === "number" && typeof state.r === "number") after = { t: state.t, r: state.r };
        }

        const fromStart = this._db.prepare<[string, number, number, number], IRow>(
            "SELECT * FROM history_samples WHERE id = ? AND t_ms >= ? AND t_ms < ? ORDER BY t_ms, received_ms LIMIT ?"
        );
        const fromAfter = this._db.prepare<[string, number, number, number, number, number], IRow>(
            "SELECT * FROM history_samples WHERE id = ? AND t_ms >= ? AND t_ms < ? AND (t_ms, received_ms) > (?, ?) ORDER BY t_ms, received_ms LIMIT ?"
        );
        const hasAny = this._db.prepare<[string, number, number], { one: number }>("SELECT 1 AS one FROM history_samples WHERE id = ? AND t_ms >= ? AND t_ms < ? LIMIT 1");

        const series: IRawSeries[] = [];
        let room = limit;
        for (let i = firstIndex; i < ids.length; i++) {
            const id = ids[i]!;
            // One row more than the room left tells whether this id has more.
            const rows = i === firstIndex && after ? fromAfter.all(id, startMs, endMs, after.t, after.r, room + 1) : fromStart.all(id, startMs, endMs, room + 1);
            const taken = rows.slice(0, room);
            series.push({ id, samples: taken.map(sampleOf) });
            room -= taken.length;
            if (room === 0) {
                if (rows.length > taken.length) {
                    const last = taken[taken.length - 1]!;
                    return page(series, encodeContinuation({ i, t: last.t_ms, r: last.received_ms }));
                }
                for (let next = i + 1; next < ids.length; next++) {
                    if (hasAny.get(ids[next]!, startMs, endMs)) return page(series, encodeContinuation({ i: next }));
                }
                return page(series, null);
            }
        }
        return page(series, null);
    }

    async readProcessedAsync(request: IReadProcessedRequest, signal?: AbortSignal): Promise<IReadProcessedResult> {
        this._enter(signal);
        const ids = parseIds(request.ids).map((path) => path.id);
        const { startMs, endMs } = parseRange(request.start, request.end);
        const intervalMs = checkBucketRequest(startMs, endMs, request.intervalMs, this._capabilities.limits.maxBucketsPerRead);
        const aggregates = parseAggregates(request.aggregates);
        const format = parseFormat(request.format);

        const inSql = aggregates.filter((aggregate) => SQL_AGGREGATES.has(aggregate));
        const fromRows = aggregates.filter((aggregate) => !SQL_AGGREGATES.has(aggregate));

        // Numbers and booleans (0 and 1) of usable samples; `bad` ones count only in goodRatio.
        // Start and interval are bound as BigInt: better-sqlite3 binds a JS number as REAL, which would make the bucket division fractional.
        const grouped = this._db.prepare<[bigint, bigint, string, number, number], Record<string, number | null>>(
            `SELECT (t_ms - ?) / ? AS k,
                    SUM(quality <> 'b')                                                     AS count_,
                    MIN(CASE WHEN quality <> 'b' AND value_type IN ('n', 'b') THEN value_num END) AS min_,
                    MAX(CASE WHEN quality <> 'b' AND value_type IN ('n', 'b') THEN value_num END) AS max_,
                    SUM(CASE WHEN quality <> 'b' AND value_type IN ('n', 'b') THEN value_num END) AS sum_,
                    AVG(CASE WHEN quality <> 'b' AND value_type IN ('n', 'b') THEN value_num END) AS avg_,
                    AVG(quality = 'g')                                                      AS good_ratio_
             FROM history_samples
             WHERE id = ? AND t_ms >= ? AND t_ms < ?
             GROUP BY k`
        );
        // Only what the reference functions read, as raw arrays: no object per row.
        const rowsOf = this._db
            .prepare<[string, number, number], [number, number, string, number | null, string | null, string]>(
                "SELECT t_ms, received_ms, value_type, value_num, value_text, quality FROM history_samples WHERE id = ? AND t_ms >= ? AND t_ms < ? ORDER BY t_ms, received_ms"
            )
            .raw(true);
        const priorOf = this._db.prepare<[string, number], IRow>("SELECT * FROM history_samples WHERE id = ? AND t_ms < ? ORDER BY t_ms DESC, received_ms DESC LIMIT 1");

        const series: IProcessedSeries[] = ids.map((id) => {
            const fromSql = new Map<number, Record<string, number | null>>();
            if (inSql.length > 0) for (const row of grouped.all(BigInt(startMs), BigInt(intervalMs), id, startMs, endMs)) fromSql.set(Number(row.k), row);

            let fromReference: IBucket[] | undefined;
            if (fromRows.length > 0) {
                const prior = priorOf.get(id, startMs);
                const points: ITimedValue[] = rowsOf.all(id, startMs, endMs).map(([t, r, type, num, text, quality]) => ({
                    timeMs: t,
                    receivedMs: r,
                    value: valueOf({ value_type: type, value_num: num, value_text: text } as IRow),
                    quality: QUALITY_OF[quality]!,
                }));
                fromReference = computeBuckets(points, prior ? timed(prior) : undefined, startMs, endMs, intervalMs, fromRows);
            }

            const buckets: IBucket[] = [];
            for (let k = 0, bucketStart = startMs; bucketStart < endMs; k++, bucketStart += intervalMs) {
                const row = fromSql.get(k);
                const values: Partial<Record<Aggregate, unknown>> = {};
                for (const aggregate of aggregates) {
                    if (!SQL_AGGREGATES.has(aggregate)) {
                        values[aggregate] = fromReference![k]!.values[aggregate] ?? null;
                        continue;
                    }
                    if (aggregate === "count") values.count = row?.count_ ?? 0;
                    else if (aggregate === "goodRatio") values.goodRatio = row?.good_ratio_ ?? null;
                    else values[aggregate] = row?.[`${aggregate}_`] ?? null;
                }
                buckets.push({ start: formatInstant(bucketStart), end: formatInstant(Math.min(bucketStart + intervalMs, endMs)), values });
            }
            return { id, buckets, computedBy: "store" };
        });
        return { format, series: formatProcessedSeries(series, format, aggregates) };
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

        const before = this._db.prepare<[string, number], IRow>("SELECT * FROM history_samples WHERE id = ? AND t_ms <= ? ORDER BY t_ms DESC, received_ms DESC LIMIT 1");
        const after = this._db.prepare<[string, number], IRow>("SELECT * FROM history_samples WHERE id = ? AND t_ms > ? ORDER BY t_ms, received_ms LIMIT 1");
        const series: IAtTimeSeries[] = ids.map((id) => ({
            id,
            values: times.map((timeMs) => {
                const b = before.get(id, timeMs);
                const a = after.get(id, timeMs);
                const answer = valueAtTime(b ? timed(b) : undefined, a ? timed(a) : undefined, timeMs, mode);
                return { time: formatInstant(timeMs), value: answer.value, quality: answer.quality, basis: answer.basis };
            }),
        }));
        return { series };
    }

    async browseAsync(request: IHistoryBrowseRequest, signal?: AbortSignal): Promise<IHistoryBrowseResult> {
        this._enter(signal);
        const root = parseRoot(request.root);
        const limit = parseLimit(request.limit, this._capabilities.limits.maxBrowseItems);
        let afterId = "";
        if (request.continuationPoint !== undefined) {
            const state = decodeContinuation(request.continuationPoint);
            if (typeof state.after !== "string") throw invalid("continuationPoint is not one this store issued");
            afterId = state.after;
        }
        // The root itself, or ids under "root/": the range ["root/", "root0") holds exactly those, "0" being the character after "/".
        const where = root ? "(id = @root OR (id >= @below AND id < @beyond)) AND id > @after" : "id > @after";
        const rows = this._db
            .prepare<Record<string, string | number>, { id: string; first: number; last: number; count: number }>(
                `SELECT id, MIN(t_ms) AS first, MAX(t_ms) AS last, COUNT(*) AS count FROM history_samples WHERE ${where} GROUP BY id ORDER BY id LIMIT @limit`
            )
            .all({ ...(root ? { root: root.id, below: `${root.id}/`, beyond: `${root.id}0` } : {}), after: afterId, limit: limit + 1 });
        const items = rows.slice(0, limit).map((row) => ({ id: row.id, first: formatInstant(row.first), last: formatInstant(row.last), count: row.count }));
        return { items, continuationPoint: rows.length > limit ? encodeContinuation({ after: items[items.length - 1]!.id }) : null };
    }

    async deleteRangeAsync(request: IDeleteRangeRequest, signal?: AbortSignal): Promise<IDeleteRangeResult> {
        this._enter(signal);
        const ids = parseIds(request.ids).map((path) => path.id);
        const { startMs, endMs } = parseRange(request.start, request.end);
        const remove = this._db.prepare("DELETE FROM history_samples WHERE id = ? AND t_ms >= ? AND t_ms < ?");
        let deleted = 0;
        this._db.transaction(() => {
            for (const id of ids) deleted += remove.run(id, startMs, endMs).changes;
        })();
        return { deleted, errors: [] };
    }

    async closeAsync(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        this._db.close();
    }

    private _checkSchemaVersion(): void {
        const row = this._db.prepare<[], { value: string }>("SELECT value FROM history_meta WHERE key = 'schema_version'").get();
        if (!row) {
            this._db.prepare("INSERT INTO history_meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
            return;
        }
        if (row.value !== String(SCHEMA_VERSION)) {
            this._db.close();
            throw new Error(`history store: the file has schema version ${row.value}, this store reads version ${SCHEMA_VERSION}`);
        }
    }

    private _enter(signal: AbortSignal | undefined): void {
        signal?.throwIfAborted();
        if (this._closed) throw new HistoryError("store_unavailable", `history store "${this.id}" is closed`);
    }
}
