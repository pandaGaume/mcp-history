import type {
    IAppendResult,
    IDeleteRangeRequest,
    IDeleteRangeResult,
    IHistoryBrowseRequest,
    IHistoryBrowseResult,
    IHistoryCapabilities,
    IHistorySample,
    IReadAtTimeRequest,
    IReadAtTimeResult,
    IReadProcessedRequest,
    IReadProcessedResult,
    IReadRawRequest,
    IReadRawResult,
} from "./history.types";

/**
 * The history.v1 contract, in its TypeScript form: what a backend implements.
 *
 * `HistoryBehavior` publishes any implementation as an MCP slot, and
 * `HistorySlotStore` reaches such a slot back as an implementation, so a
 * local store, a remote slot and a router are interchangeable. The semantics
 * every implementation must share are pinned by the conformance suite
 * (`@cyanmycelium/mcp-history/conformance`), not by this file alone.
 *
 * Request-level problems (malformed request, limit exceeded, unsupported
 * operation) reject with a `HistoryError`. Per-sample problems are reported
 * in `IAppendResult.rejected` and never fail the whole append.
 */
export interface IHistoryStore {
    readonly id: string;
    getCapabilitiesAsync(signal?: AbortSignal): Promise<IHistoryCapabilities>;
    /** Idempotent on `(id, time, receivedTimestamp)`: replaying a buffer records nothing twice. */
    appendAsync(samples: readonly IHistorySample[], signal?: AbortSignal): Promise<IAppendResult>;
    readRawAsync(request: IReadRawRequest, signal?: AbortSignal): Promise<IReadRawResult>;
    readProcessedAsync(request: IReadProcessedRequest, signal?: AbortSignal): Promise<IReadProcessedResult>;
    readAtTimeAsync(request: IReadAtTimeRequest, signal?: AbortSignal): Promise<IReadAtTimeResult>;
    browseAsync(request: IHistoryBrowseRequest, signal?: AbortSignal): Promise<IHistoryBrowseResult>;
    /** Rejects with `unsupported_capability` when `operations.delete` is false. */
    deleteRangeAsync(request: IDeleteRangeRequest, signal?: AbortSignal): Promise<IDeleteRangeResult>;
    closeAsync(): Promise<void>;
}
