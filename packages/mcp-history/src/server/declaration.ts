import { UnsPath, type UnsId } from "@cyanmycelium/mcp-uns";

export const HISTORY_DOMAIN = "history";

export const HISTORY_CAPABILITIES = {
    /** `browse`, `read_raw`, `read_processed`, `read_at_time`. */
    read: "history.read",
    /** `append`: the recorder, nobody else. */
    record: "history.record",
    /** `delete_range`. */
    admin: "history.admin",
} as const;

/** Mutations: the broker expects their outcome, and flags a decision left without one. */
export const HISTORY_RESULTS_REQUIRED = [HISTORY_CAPABILITIES.record, HISTORY_CAPABILITIES.admin] as const;

export interface IHistoryDeclarationInput {
    /** Version string of this declaration; the broker echoes it back. */
    readonly version: string;
    /** UNS subtree this slot serves; the broker refuses any check outside it. */
    readonly namespace: UnsId;
    /** Storage slots only this slot may call; each must already be in the broker's `protectedSlots`. */
    readonly protects?: readonly string[];
}

/**
 * The `broker/authorization/declare` payload of a history slot, shaped as
 * mcp-broker-provider's `IAuthorizationDeclaration`.
 *
 * Descriptive only: an address space, a capability vocabulary and the storage
 * slots to protect. No role, assignment or deny, so the slot cannot authorize
 * itself. History reuses the SCADA address space: the same UNS id is the same
 * broker resource path, and an assignment on `/site1/line1/**` governs both
 * the live value and its history.
 *
 * Throws when the input is incoherent, so a bad declaration fails in the
 * deployment that wrote it rather than as a refusal from the broker.
 */
export function buildHistoryDeclaration(input: IHistoryDeclarationInput) {
    const problems: string[] = [];
    const namespace = UnsPath.tryParse(input.namespace);
    if (!namespace) problems.push(`namespace "${input.namespace}" is not a UNS id`);
    if (!input.version) problems.push("version is required");
    const protects = [...new Set(input.protects ?? [])];
    for (const slot of protects) {
        if (!slot || slot.startsWith("_")) problems.push(`slot "${slot}" cannot be protected`);
    }
    if (problems.length > 0) throw new Error(`declaration refused locally: ${problems.join("; ")}`);
    return {
        version: input.version,
        domain: HISTORY_DOMAIN,
        namespace: { resource: namespace!.resourcePath },
        capabilities: Object.values(HISTORY_CAPABILITIES),
        protects,
        resultsRequired: [...HISTORY_RESULTS_REQUIRED],
    };
}
