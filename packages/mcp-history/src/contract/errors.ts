export type HistoryErrorCode =
    | "invalid_request"
    | "unknown_resource"
    | "unsupported_capability"
    | "unsupported_value_type"
    | "limit_exceeded"
    | "policy_denied"
    | "authorization_unavailable"
    | "store_unavailable"
    | "store_error";

export const HISTORY_ERROR_CODES: readonly HistoryErrorCode[] = [
    "invalid_request",
    "unknown_resource",
    "unsupported_capability",
    "unsupported_value_type",
    "limit_exceeded",
    "policy_denied",
    "authorization_unavailable",
    "store_unavailable",
    "store_error",
];

/** The serialized form of an error, as it travels in a tool result. */
export interface IHistoryErrorBody {
    readonly code: HistoryErrorCode;
    readonly message: string;
    /** Broker decision that refused the request, when there was one. */
    readonly decisionId?: string;
    readonly detail?: Readonly<Record<string, unknown>>;
}

/** A normalized failure of a history or cache store, shared by both contracts. */
export class HistoryError extends Error implements IHistoryErrorBody {
    readonly code: HistoryErrorCode;
    readonly decisionId?: string;
    readonly detail?: Readonly<Record<string, unknown>>;

    constructor(code: HistoryErrorCode, message: string, options: { decisionId?: string; detail?: Readonly<Record<string, unknown>> } = {}) {
        super(message);
        this.name = "HistoryError";
        this.code = code;
        this.decisionId = options.decisionId;
        this.detail = options.detail;
    }

    toBody(): IHistoryErrorBody {
        return {
            code: this.code,
            message: this.message,
            ...(this.decisionId ? { decisionId: this.decisionId } : {}),
            ...(this.detail ? { detail: this.detail } : {}),
        };
    }

    static toBody(error: unknown): IHistoryErrorBody {
        if (error instanceof HistoryError) return error.toBody();
        return { code: "store_error", message: error instanceof Error ? error.message : String(error) };
    }

    /** Rebuilds the error a slot reported, so a remote store fails like a local one. */
    static fromBody(body: unknown): HistoryError {
        const candidate = (typeof body === "object" && body !== null ? body : {}) as Partial<IHistoryErrorBody>;
        const code = HISTORY_ERROR_CODES.includes(candidate.code as HistoryErrorCode) ? (candidate.code as HistoryErrorCode) : "store_error";
        const message = typeof candidate.message === "string" ? candidate.message : "the store reported an error without a message";
        return new HistoryError(code, message, {
            ...(typeof candidate.decisionId === "string" ? { decisionId: candidate.decisionId } : {}),
            ...(typeof candidate.detail === "object" && candidate.detail !== null ? { detail: candidate.detail } : {}),
        });
    }
}

export function invalid(message: string, detail?: Readonly<Record<string, unknown>>): HistoryError {
    return new HistoryError("invalid_request", message, detail ? { detail } : {});
}
