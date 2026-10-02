import {
    McpAdapterBase,
    McpBehavior,
    McpToolResults,
    type IMcpRequestContext,
    type McpResource,
    type McpResourceContent,
    type McpTool,
    type McpToolResult,
} from "@cyanmycelium/mcp-core";
import { HistoryError, invalid, type IHistoryErrorBody } from "../contract/errors";
import type { IHistoryStore } from "../contract/history.store";
import {
    AGGREGATES,
    AT_TIME_MODES,
    READ_FORMATS,
    type IAppendResult,
    type IDeleteRangeResult,
    type IHistorySample,
    type IRejectedSample,
    type ISeriesError,
    type ReadFormat,
} from "../contract/history.types";
import { UnsPath, type UnsId } from "@cyanmycelium/mcp-uns";
import { parseFormat, parseIds } from "../contract/validation";
import { AccessUnavailableError, unsChecks, type AccessOutcome, type IAccessDecision, type IAccessGuard } from "@cyanmycelium/mcp-uns";
import { HISTORY_CAPABILITIES } from "./declaration";

export const HISTORY_CAPABILITIES_URI = "history://capabilities";

export interface IHistoryBehaviorOptions {
    /**
     * How a tool result carries its data:
     * - `both` (default): a JSON `text` block and the same object as
     *   `structuredContent`, for every MCP client, old and new;
     * - `structured`: the object only as `structuredContent`, with a short
     *   `text`. Half the bytes; for clients that read `structuredContent`
     *   (MCP 2025-06-18), such as `HistorySlotStore`.
     */
    readonly payload?: "both" | "structured";
}

interface IGuarded {
    readonly allowed: UnsId[];
    readonly decisions: Map<UnsId, IAccessDecision>;
    readonly denied: ISeriesError[];
}

function denial(id: UnsId, decision: IAccessDecision): ISeriesError {
    return {
        id,
        error: {
            code: "policy_denied",
            message: `access to ${id} was refused`,
            ...(decision.decisionId ? { decisionId: decision.decisionId } : {}),
            detail: { reason: decision.reason },
        },
    };
}

/** Merges the store's series with the refusals, in the order of the requested ids. */
function inRequestOrder<T extends { readonly id: UnsId }>(ids: readonly UnsId[], series: readonly T[], denied: readonly ISeriesError[]): (T | ISeriesError)[] {
    const byId = new Map<UnsId, T | ISeriesError>();
    for (const item of series) byId.set(item.id, item);
    for (const item of denied) byId.set(item.id, item);
    return ids.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
}

class HistoryAdapter extends McpAdapterBase {
    constructor(
        private readonly _store: IHistoryStore,
        private readonly _guard: IAccessGuard,
        private readonly _payload: "both" | "structured"
    ) {
        super("history");
    }

    private _json(data: object): McpToolResult {
        if (this._payload === "both") return McpToolResults.json(data);
        return { content: [{ type: "text", text: "The result is in structuredContent." }], structuredContent: data as { [key: string]: unknown } };
    }

    async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        if (uri !== HISTORY_CAPABILITIES_URI) return undefined;
        return { uri, mimeType: "application/json", text: JSON.stringify(await this._store.getCapabilitiesAsync()) };
    }

    async executeToolAsync(_uri: string, toolName: string, args: Record<string, unknown>, request?: IMcpRequestContext): Promise<McpToolResult> {
        try {
            switch (toolName) {
                case "history.capabilities":
                    return this._json(await this._store.getCapabilitiesAsync());
                case "history.browse":
                    return this._json(await this._browseAsync(args, request));
                case "history.read_raw":
                    return this._json(await this._readAsync(args, request, (ids) => this._store.readRawAsync({ ...args, ids } as never), true, parseFormat(args.format)));
                case "history.read_processed":
                    return this._json(await this._readAsync(args, request, (ids) => this._store.readProcessedAsync({ ...args, ids } as never), false, parseFormat(args.format)));
                case "history.read_at_time":
                    return this._json(await this._readAsync(args, request, (ids) => this._store.readAtTimeAsync({ ...args, ids } as never), false));
                case "history.append":
                    return this._json(await this._appendAsync(args, request));
                case "history.delete_range":
                    return this._json(await this._deleteAsync(args, request));
                default:
                    return McpToolResults.error(`unknown tool: ${toolName}`);
            }
        } catch (error) {
            const body: IHistoryErrorBody = HistoryError.toBody(error);
            return { content: [{ type: "text", text: JSON.stringify({ error: body }) }], isError: true };
        }
    }

    private async _guardAsync(capability: string, ids: readonly UnsId[], request: IMcpRequestContext | undefined): Promise<IGuarded> {
        let answers: IAccessDecision[];
        try {
            answers = await this._guard.authorizeAsync(unsChecks(capability, ids), request);
        } catch (error) {
            if (error instanceof AccessUnavailableError) throw new HistoryError("authorization_unavailable", error.message);
            throw error;
        }
        const decisions = new Map<UnsId, IAccessDecision>();
        const allowed: UnsId[] = [];
        const denied: ISeriesError[] = [];
        ids.forEach((id, index) => {
            const decision = answers[index] ?? { allowed: false, reason: "no-decision" };
            decisions.set(id, decision);
            if (decision.allowed) allowed.push(id);
            else denied.push(denial(id, decision));
        });
        return { allowed, decisions, denied };
    }

    /** Ids are checked one by one; the refused ones come back as series errors, the others are served. */
    private async _readAsync<T extends { readonly series: readonly { readonly id: UnsId }[]; readonly continuationPoint?: string | null }>(
        args: Record<string, unknown>,
        request: IMcpRequestContext | undefined,
        read: (ids: UnsId[]) => Promise<T>,
        paged: boolean,
        format?: ReadFormat
    ): Promise<T> {
        const ids = parseIds(args.ids).map((path) => path.id);
        const guarded = await this._guardAsync(HISTORY_CAPABILITIES.read, ids, request);
        // A continuation page does not repeat the refusals of the first one.
        const denied = paged && args.continuationPoint !== undefined ? [] : guarded.denied;
        if (guarded.allowed.length === 0) return { ...(format ? { format } : {}), series: denied, ...(paged ? { continuationPoint: null } : {}) } as unknown as T;
        const result = await read(guarded.allowed);
        return { ...result, series: inRequestOrder(ids, result.series, denied) };
    }

    /** Browse is filtered after the fact: an id the caller may not read is left out, as if it had no history. */
    private async _browseAsync(args: Record<string, unknown>, request: IMcpRequestContext | undefined) {
        const result = await this._store.browseAsync(args as never);
        if (result.items.length === 0) return result;
        const guarded = await this._guardAsync(
            HISTORY_CAPABILITIES.read,
            result.items.map((item) => item.id),
            request
        );
        const allowed = new Set(guarded.allowed);
        return { ...result, items: result.items.filter((item) => allowed.has(item.id)) };
    }

    private async _appendAsync(args: Record<string, unknown>, request: IMcpRequestContext | undefined): Promise<IAppendResult> {
        const samples = args.samples;
        if (!Array.isArray(samples)) throw invalid("samples must be an array");

        // Only well-formed ids are put to the broker; the store rejects the others with its own reason.
        const ids = [
            ...new Set(
                samples
                    .map((sample) => (typeof sample === "object" && sample !== null ? (sample as IHistorySample).id : undefined))
                    .filter((id): id is UnsId => typeof id === "string" && UnsPath.tryParse(id)?.id === id)
            ),
        ];
        const guarded = await this._guardAsync(HISTORY_CAPABILITIES.record, ids, request);

        const forwarded: IHistorySample[] = [];
        const origin: number[] = [];
        const rejected: IRejectedSample[] = [];
        samples.forEach((sample, index) => {
            const id = (sample as IHistorySample | null)?.id;
            const decision = typeof id === "string" ? guarded.decisions.get(id) : undefined;
            if (decision && !decision.allowed) {
                rejected.push({ index, error: denial(id!, decision).error });
                return;
            }
            forwarded.push(sample as IHistorySample);
            origin.push(index);
        });

        let result: IAppendResult = { accepted: 0, duplicates: 0, rejected: [] };
        if (forwarded.length > 0) {
            try {
                result = await this._store.appendAsync(forwarded);
            } catch (error) {
                this._reportAll(guarded, "failure", HistoryError.toBody(error).code);
                throw error;
            }
        }

        // One outcome per allowed id: a failure if the store rejected any of its samples.
        const failedIds = new Map<UnsId, string>();
        const storeRejected = result.rejected.map((item) => {
            const index = origin[item.index]!;
            const id = (samples[index] as IHistorySample | null)?.id;
            if (typeof id === "string" && !failedIds.has(id)) failedIds.set(id, item.error.code);
            return { index, error: item.error };
        });
        for (const id of guarded.allowed) {
            const errorCode = failedIds.get(id);
            this._guard.report(guarded.decisions.get(id)!, errorCode ? "failure" : "success", errorCode);
        }
        return { accepted: result.accepted, duplicates: result.duplicates, rejected: [...rejected, ...storeRejected].sort((a, b) => a.index - b.index) };
    }

    private async _deleteAsync(args: Record<string, unknown>, request: IMcpRequestContext | undefined): Promise<IDeleteRangeResult> {
        const ids = parseIds(args.ids).map((path) => path.id);
        const guarded = await this._guardAsync(HISTORY_CAPABILITIES.admin, ids, request);
        if (guarded.allowed.length === 0) return { deleted: 0, errors: guarded.denied };

        let result: IDeleteRangeResult;
        try {
            result = await this._store.deleteRangeAsync({ ids: guarded.allowed, start: args.start as string, end: args.end as string });
        } catch (error) {
            this._reportAll(guarded, "failure", HistoryError.toBody(error).code);
            throw error;
        }
        const failed = new Map(result.errors.map((item) => [item.id, item.error.code]));
        for (const id of guarded.allowed) {
            const errorCode = failed.get(id);
            this._guard.report(guarded.decisions.get(id)!, errorCode ? "failure" : "success", errorCode);
        }
        return { deleted: result.deleted, errors: inRequestOrder(ids, result.errors, guarded.denied) as ISeriesError[] };
    }

    private _reportAll(guarded: IGuarded, outcome: AccessOutcome, errorCode: string): void {
        for (const id of guarded.allowed) this._guard.report(guarded.decisions.get(id)!, outcome, errorCode);
    }
}

/**
 * The MCP surface of history.v1: publishes any {@link IHistoryStore} as a slot.
 *
 * Every operation that names ids asks the guard first, one check per id, and
 * serves only the allowed ones; the refused ids come back as per-id errors.
 * Mutations report their outcome under the decision that allowed them.
 */
export class HistoryBehavior extends McpBehavior {
    constructor(store: IHistoryStore, guard: IAccessGuard, options: IHistoryBehaviorOptions = {}) {
        super(new HistoryAdapter(store, guard, options.payload ?? "both"), { namespace: "history" });
    }

    protected override _buildResources(): McpResource[] {
        return [
            { uri: HISTORY_CAPABILITIES_URI, name: "History capabilities", description: "history.v1 capabilities of the store behind this slot.", mimeType: "application/json" },
        ];
    }

    protected override _buildTools(): McpTool[] {
        const ids = { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true, description: "UNS ids, e.g. uns://site1/line1/motor01/speed" };
        const instant = (what: string) => ({ type: "string", description: `${what}, ISO 8601 with an offset, e.g. 2026-10-02T08:00:00.000Z` });
        const range = { start: instant("Inclusive start"), end: instant("Exclusive end") };
        const continuationPoint = { type: "string", description: "Opaque, from the previous page of the same request." };
        const format = {
            type: "string",
            enum: [...READ_FORMATS],
            description:
                "rows (default): one object per sample or bucket. columns: parallel arrays per series, instants in epoch ms; several times smaller, for charts and bulk reads.",
        };
        const sample = {
            type: "object",
            properties: {
                id: { type: "string" },
                value: { description: "A number, a boolean, a string or a JSON value." },
                quality: { type: "string", enum: ["good", "uncertain", "bad"] },
                sourceTimestamp: { type: ["string", "null"], description: "null when the protocol carries none. Never synthesize one." },
                receivedTimestamp: { type: "string" },
                provider: { type: "string" },
            },
            required: ["id", "value", "quality", "sourceTimestamp", "receivedTimestamp", "provider"],
        };
        return [
            {
                name: "history.capabilities",
                description: "What the store behind this slot records and computes: value types, native aggregates, delete support, retention, limits.",
                inputSchema: { type: "object", properties: {} },
            },
            {
                name: "history.browse",
                description: "List the UNS ids that have a history, with first and last time and sample count. Ids you may not read are left out.",
                inputSchema: {
                    type: "object",
                    properties: { root: { type: "string", description: "UNS subtree, matched by whole segments." }, limit: { type: "integer", minimum: 1 }, continuationPoint },
                },
            },
            {
                name: "history.read_raw",
                description:
                    "Read recorded samples in [start, end), ordered by id then time, with their quality, both timestamps and which one is the time axis. Paged: pass continuationPoint back until it is null.",
                inputSchema: {
                    type: "object",
                    properties: { ids, ...range, limit: { type: "integer", minimum: 1 }, continuationPoint, format },
                    required: ["ids", "start", "end"],
                },
            },
            {
                name: "history.read_processed",
                description:
                    "Aggregate [start, end) in buckets of intervalMs. Bad samples count only in goodRatio; timeWeightedAvg holds each value until the next sample; an empty bucket gives null.",
                inputSchema: {
                    type: "object",
                    properties: {
                        ids,
                        ...range,
                        intervalMs: { type: "integer", minimum: 1 },
                        aggregates: { type: "array", items: { type: "string", enum: [...AGGREGATES] }, minItems: 1 },
                        format,
                    },
                    required: ["ids", "start", "end", "intervalMs", "aggregates"],
                },
            },
            {
                name: "history.read_at_time",
                description:
                    "The value of each id at given instants: the last sample before (stepped), or linear between the two usable numeric samples around (interpolated). Each answer says which.",
                inputSchema: {
                    type: "object",
                    properties: { ids, times: { type: "array", items: { type: "string" }, minItems: 1 }, mode: { type: "string", enum: [...AT_TIME_MODES] } },
                    required: ["ids", "times", "mode"],
                },
            },
            {
                name: "history.append",
                description:
                    "Record samples. Idempotent on (id, time, receivedTimestamp), so a buffer can be replayed. Bad-quality samples are recorded too. Each refused sample is reported with its index.",
                inputSchema: { type: "object", properties: { samples: { type: "array", items: sample, minItems: 1 } }, required: ["samples"] },
            },
            {
                name: "history.delete_range",
                description: "Delete the samples of [start, end) for the given ids. Administration only; audited by the broker.",
                inputSchema: { type: "object", properties: { ids, ...range }, required: ["ids", "start", "end"] },
            },
        ];
    }
}
