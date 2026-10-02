import { invalid } from "./errors";

/**
 * Continuation points are opaque to clients, but every store of this package
 * encodes them the same way: base64url JSON. A store is free to put anything
 * in them; clients only hand them back.
 *
 * No `Buffer`: the contract also runs in a browser page publishing a slot.
 */
export function encodeContinuation(state: Readonly<Record<string, unknown>>): string {
    const bytes = new TextEncoder().encode(JSON.stringify(state));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeContinuation(point: unknown): Record<string, unknown> {
    if (typeof point !== "string" || point.length === 0) throw invalid("continuationPoint must be a string returned by a previous page");
    try {
        const binary = atob(point.replace(/-/g, "+").replace(/_/g, "/"));
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        const state = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
        if (typeof state === "object" && state !== null && !Array.isArray(state)) return state as Record<string, unknown>;
    } catch {
        // fall through
    }
    throw invalid("continuationPoint is not one this store issued");
}
