import { describe, expect, it } from "vitest";
import { buildHistoryDeclaration } from "@cyanmycelium/mcp-history";

describe("buildHistoryDeclaration", () => {
    it("declares the history domain over the UNS namespace, and grants nothing", () => {
        expect(buildHistoryDeclaration({ version: "3", namespace: "uns://site1", protects: ["history-sqlite"] })).toEqual({
            version: "3",
            domain: "history",
            namespace: { resource: "/site1" },
            capabilities: ["history.read", "history.record", "history.admin"],
            protects: ["history-sqlite"],
            resultsRequired: ["history.record", "history.admin"],
        });
    });

    it("refuses an incoherent declaration locally", () => {
        expect(() => buildHistoryDeclaration({ version: "", namespace: "site1", protects: ["_broker"] })).toThrow(/namespace.*version.*_broker/);
    });
});
