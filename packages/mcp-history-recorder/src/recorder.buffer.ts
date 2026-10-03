import Database from "better-sqlite3";
import type { IHistorySample } from "@cyanmycelium/mcp-history";

export interface IBufferedSample {
    /** Increasing; acknowledging a sequence number acknowledges everything up to it. */
    readonly seq: number;
    readonly sample: IHistorySample;
}

/**
 * The recorder's store-and-forward queue: samples wait here until the history
 * slot has them. First in, first out. Bounded: past `maxSize`, the oldest
 * samples are dropped, and counted, so a long outage costs the oldest data
 * rather than the process.
 */
export interface IRecorderBuffer {
    pushAsync(samples: readonly IHistorySample[]): Promise<void>;
    /** The oldest samples, without removing them. */
    peekAsync(max: number): Promise<IBufferedSample[]>;
    /** Removes every sample up to and including `seq`. */
    ackAsync(seq: number): Promise<void>;
    sizeAsync(): Promise<number>;
    /** Samples dropped because the buffer was full, since it was opened. */
    readonly dropped: number;
    closeAsync(): Promise<void>;
}

/** The buffer in memory: what is not flushed is lost with the process. */
export class MemoryRecorderBuffer implements IRecorderBuffer {
    private readonly _queue: IBufferedSample[] = [];
    private _next = 1;
    private _dropped = 0;

    constructor(private readonly _maxSize = 100_000) {}

    get dropped(): number {
        return this._dropped;
    }

    async pushAsync(samples: readonly IHistorySample[]): Promise<void> {
        for (const sample of samples) this._queue.push({ seq: this._next++, sample: structuredClone(sample) });
        const excess = this._queue.length - this._maxSize;
        if (excess > 0) {
            this._queue.splice(0, excess);
            this._dropped += excess;
        }
    }

    async peekAsync(max: number): Promise<IBufferedSample[]> {
        return this._queue.slice(0, max);
    }

    async ackAsync(seq: number): Promise<void> {
        let count = 0;
        while (count < this._queue.length && this._queue[count]!.seq <= seq) count++;
        this._queue.splice(0, count);
    }

    async sizeAsync(): Promise<number> {
        return this._queue.length;
    }

    async closeAsync(): Promise<void> {}
}

/**
 * The buffer in a SQLite file: samples survive a restart of the recorder, and
 * are replayed when the history slot is back. Replaying is safe because
 * `history.append` is idempotent.
 */
export class SqliteRecorderBuffer implements IRecorderBuffer {
    private readonly _db: Database.Database;
    private _dropped = 0;

    constructor(
        path: string,
        private readonly _maxSize = 1_000_000
    ) {
        this._db = new Database(path);
        if (path !== ":memory:") this._db.pragma("journal_mode = WAL");
        this._db.exec("CREATE TABLE IF NOT EXISTS recorder_queue (seq INTEGER PRIMARY KEY AUTOINCREMENT, sample TEXT NOT NULL)");
    }

    get dropped(): number {
        return this._dropped;
    }

    async pushAsync(samples: readonly IHistorySample[]): Promise<void> {
        if (samples.length === 0) return;
        const insert = this._db.prepare("INSERT INTO recorder_queue (sample) VALUES (?)");
        this._db.transaction(() => {
            for (const sample of samples) insert.run(JSON.stringify(sample));
            const size = (this._db.prepare("SELECT COUNT(*) AS n FROM recorder_queue").get() as { n: number }).n;
            const excess = size - this._maxSize;
            if (excess > 0) {
                this._db.prepare("DELETE FROM recorder_queue WHERE seq IN (SELECT seq FROM recorder_queue ORDER BY seq LIMIT ?)").run(excess);
                this._dropped += excess;
            }
        })();
    }

    async peekAsync(max: number): Promise<IBufferedSample[]> {
        const rows = this._db.prepare("SELECT seq, sample FROM recorder_queue ORDER BY seq LIMIT ?").all(max) as { seq: number; sample: string }[];
        return rows.map((row) => ({ seq: row.seq, sample: JSON.parse(row.sample) as IHistorySample }));
    }

    async ackAsync(seq: number): Promise<void> {
        this._db.prepare("DELETE FROM recorder_queue WHERE seq <= ?").run(seq);
    }

    async sizeAsync(): Promise<number> {
        return (this._db.prepare("SELECT COUNT(*) AS n FROM recorder_queue").get() as { n: number }).n;
    }

    async closeAsync(): Promise<void> {
        if (this._db.open) this._db.close();
    }
}
