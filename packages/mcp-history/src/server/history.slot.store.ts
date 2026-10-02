import { HistoryError } from "../contract/errors";
import type { IHistoryStore } from "../contract/history.store";
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
} from "../contract/history.types";

/** The part of an MCP client a slot store needs. mcp-core's `McpClient` satisfies it. */
export interface ISlotClient {
    callTool(name: string, args: Record<string, unknown>): Promise<{ content?: readonly unknown[]; structuredContent?: unknown; isError?: boolean }>;
}

/**
 * A history.v1 slot, reached as an {@link IHistoryStore}.
 *
 * It is how a router reaches the storage slots behind it, and how a test
 * proves that a store published by `HistoryBehavior` behaves like the store
 * itself: the conformance suite runs unchanged through it. A slot error comes
 * back as the same `HistoryError` the store threw.
 */
export class HistorySlotStore implements IHistoryStore {
    constructor(
        readonly id: string,
        private readonly _client: ISlotClient
    ) {}

    getCapabilitiesAsync(signal?: AbortSignal): Promise<IHistoryCapabilities> {
        return this._callAsync("history.capabilities", {}, signal);
    }

    appendAsync(samples: readonly IHistorySample[], signal?: AbortSignal): Promise<IAppendResult> {
        return this._callAsync("history.append", { samples }, signal);
    }

    readRawAsync(request: IReadRawRequest, signal?: AbortSignal): Promise<IReadRawResult> {
        return this._callAsync("history.read_raw", request, signal);
    }

    readProcessedAsync(request: IReadProcessedRequest, signal?: AbortSignal): Promise<IReadProcessedResult> {
        return this._callAsync("history.read_processed", request, signal);
    }

    readAtTimeAsync(request: IReadAtTimeRequest, signal?: AbortSignal): Promise<IReadAtTimeResult> {
        return this._callAsync("history.read_at_time", request, signal);
    }

    browseAsync(request: IHistoryBrowseRequest, signal?: AbortSignal): Promise<IHistoryBrowseResult> {
        return this._callAsync("history.browse", request, signal);
    }

    deleteRangeAsync(request: IDeleteRangeRequest, signal?: AbortSignal): Promise<IDeleteRangeResult> {
        return this._callAsync("history.delete_range", request, signal);
    }

    /** The client belongs to whoever connected it; closing the store does not disconnect it. */
    async closeAsync(): Promise<void> {}

    private async _callAsync<T>(tool: string, args: object, signal: AbortSignal | undefined): Promise<T> {
        signal?.throwIfAborted();
        let result: Awaited<ReturnType<ISlotClient["callTool"]>>;
        try {
            result = await this._client.callTool(tool, { ...args });
        } catch (error) {
            throw new HistoryError("store_unavailable", `history slot "${this.id}" did not answer ${tool}: ${error instanceof Error ? error.message : String(error)}`);
        }
        const payload = payloadOf(result);
        if (result.isError) {
            const body = typeof payload === "object" && payload !== null ? (payload as { error?: unknown }).error : undefined;
            throw body ? HistoryError.fromBody(body) : new HistoryError("store_error", `history slot "${this.id}" failed ${tool}: ${textOf(result) ?? "no detail"}`);
        }
        if (typeof payload !== "object" || payload === null) throw new HistoryError("store_error", `history slot "${this.id}" answered ${tool} with no JSON object`);
        return payload as T;
    }
}

function textOf(result: { content?: readonly unknown[] }): string | undefined {
    const block = result.content?.find((item) => (item as { type?: unknown }).type === "text") as { text?: unknown } | undefined;
    return typeof block?.text === "string" ? block.text : undefined;
}

function payloadOf(result: { content?: readonly unknown[]; structuredContent?: unknown }): unknown {
    if (typeof result.structuredContent === "object" && result.structuredContent !== null) return result.structuredContent;
    const text = textOf(result);
    if (text === undefined) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}
