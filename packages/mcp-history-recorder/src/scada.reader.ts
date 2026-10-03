import type { ISlotClient, Quality } from "@cyanmycelium/mcp-history";
import type { UnsId } from "@cyanmycelium/mcp-uns";

/**
 * A SCADA v1 value, as `scada.read` returns it. Restated here, field for
 * field, so the recorder does not depend on mcp-scada.
 */
export interface IScadaValueLike {
    readonly id: UnsId;
    readonly value: unknown;
    readonly quality: Quality;
    readonly sourceTimestamp: string | null;
    readonly receivedTimestamp: string;
    readonly provenance: { readonly provider: string };
}

/** An id `scada.read` could not serve, with the SCADA error code (`policy_denied`, `native_protocol_error`...). */
export interface IScadaReadError {
    readonly id: UnsId;
    readonly error: { readonly code: string; readonly message: string };
}

export type ScadaReadItem = IScadaValueLike | IScadaReadError;

export function isScadaReadError(item: ScadaReadItem): item is IScadaReadError {
    return (item as IScadaReadError).error !== undefined;
}

/** Where the recorder reads current values. */
export interface IScadaReader {
    /** One item per id, in the order asked. Rejects when the whole read fails (slot unreachable, request refused). */
    readAsync(ids: readonly UnsId[]): Promise<ScadaReadItem[]>;
}

export interface IScadaSlotReaderOptions {
    /** SCADA v1 destination. Default `source`: the recorder records what the equipment says. */
    readonly destination?: string | readonly string[];
    /** SCADA v1 consistency, e.g. `{ mode: "max-age", maxAgeMs: 500 }`. Default: the destination's own. */
    readonly consistency?: { readonly mode: string; readonly maxAgeMs?: number };
}

/**
 * Reads through a `scada` slot with `scada.read`. The recorder is then one
 * more caller of mcp-scada: the broker decides its reads like anybody's
 * (`scada.acquire` for a source read), and audits them.
 */
export class ScadaSlotReader implements IScadaReader {
    private readonly _destination: string | readonly string[];

    constructor(
        private readonly _client: ISlotClient,
        private readonly _options: IScadaSlotReaderOptions = {}
    ) {
        this._destination = _options.destination ?? "source";
    }

    async readAsync(ids: readonly UnsId[]): Promise<ScadaReadItem[]> {
        const result = await this._client.callTool("scada.read", {
            ids: [...ids],
            destination: this._destination,
            ...(this._options.consistency ? { consistency: this._options.consistency } : {}),
        });
        const payload = payloadOf(result) as { items?: ScadaReadItem[]; error?: { code?: string; message?: string } } | undefined;
        if (result.isError || !payload || !Array.isArray(payload.items)) {
            const error = payload?.error;
            throw new Error(`scada.read failed: ${error?.code ?? "no_result"}: ${error?.message ?? "the scada slot gave no items"}`);
        }
        return payload.items;
    }
}

function payloadOf(result: { content?: readonly unknown[]; structuredContent?: unknown }): unknown {
    if (typeof result.structuredContent === "object" && result.structuredContent !== null) return result.structuredContent;
    const block = result.content?.find((item) => (item as { type?: unknown }).type === "text") as { text?: unknown } | undefined;
    if (typeof block?.text !== "string") return undefined;
    try {
        return JSON.parse(block.text);
    } catch {
        return undefined;
    }
}
