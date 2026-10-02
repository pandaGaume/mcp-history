import type { Aggregate, IProcessedColumns, IProcessedSeries, IRawColumns, IRawSeries, ISeriesError, ReadFormat } from "./history.types";

export function isRawColumns(series: object): series is IRawColumns {
    return Array.isArray((series as IRawColumns).time);
}

export function isProcessedColumns(series: object): series is IProcessedColumns {
    return Array.isArray((series as IProcessedColumns).start);
}

/** A raw series, rows to columns. Instants become epoch milliseconds. */
export function toRawColumns(series: IRawSeries): IRawColumns {
    const samples = series.samples;
    return {
        id: series.id,
        time: samples.map((sample) => Date.parse(sample.time)),
        value: samples.map((sample) => sample.value),
        quality: samples.map((sample) => sample.quality),
        sourceTimestamp: samples.map((sample) => (sample.sourceTimestamp === null ? null : Date.parse(sample.sourceTimestamp))),
        receivedTimestamp: samples.map((sample) => Date.parse(sample.receivedTimestamp)),
        provider: samples.map((sample) => sample.provider),
    };
}

/** A processed series, rows to columns. */
export function toProcessedColumns(series: IProcessedSeries, aggregates: readonly Aggregate[]): IProcessedColumns {
    const values: Partial<Record<Aggregate, unknown[]>> = {};
    for (const aggregate of aggregates) values[aggregate] = series.buckets.map((bucket) => bucket.values[aggregate] ?? null);
    return { id: series.id, start: series.buckets.map((bucket) => Date.parse(bucket.start)), values, computedBy: series.computedBy };
}

/**
 * Lays out the series a store built as rows in the requested format. A store
 * computes rows and calls this last: every backend then serves both formats
 * the same way, and only one of them has to be written.
 */
export function formatRawSeries(series: readonly (IRawSeries | ISeriesError)[], format: ReadFormat): (IRawSeries | IRawColumns | ISeriesError)[] {
    return format === "columns" ? series.map((item) => ("samples" in item ? toRawColumns(item) : item)) : [...series];
}

export function formatProcessedSeries(
    series: readonly (IProcessedSeries | ISeriesError)[],
    format: ReadFormat,
    aggregates: readonly Aggregate[]
): (IProcessedSeries | IProcessedColumns | ISeriesError)[] {
    return format === "columns" ? series.map((item) => ("buckets" in item ? toProcessedColumns(item, aggregates) : item)) : [...series];
}
