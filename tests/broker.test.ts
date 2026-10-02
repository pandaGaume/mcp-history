import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestBroker, type ITestBroker } from "@cyanmycelium/mcp-broker/testing";
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";
import { McpClient, McpServerBuilder, type IMcpServer } from "@cyanmycelium/mcp-core";
import { StreamableHttpTransport } from "@cyanmycelium/mcp-core/node";
import { BrokerAccessGuard } from "@cyanmycelium/mcp-uns";
import { HistoryBehavior, HistorySlotStore, MemoryHistoryStore, buildHistoryDeclaration, isSeriesError, type IHistorySample, type IRawSeries } from "@cyanmycelium/mcp-history";

const LINE1 = "uns://site1/line1/motor01/speed";
const LINE2 = "uns://site1/line2/motor01/speed";
const at = (seconds: number) => new Date(Date.parse("2026-01-01T00:00:00.000Z") + seconds * 1000).toISOString();
const sample = (id: string, seconds: number, value: number): IHistorySample => ({
    id,
    value,
    quality: "good",
    sourceTimestamp: null,
    receivedTimestamp: at(seconds),
    provider: "modbus-bench",
});

/**
 * The history slot behind a real broker: the slot declares the `history`
 * domain, every caller comes with a token, and the broker's policy engine
 * decides each id. The slot decides nothing.
 */
describe("history slot under broker policy", () => {
    let broker: ITestBroker;
    let server: IMcpServer;
    const clients: McpClient[] = [];

    async function as(caller: string): Promise<HistorySlotStore> {
        const client = new McpClient({ name: caller, version: "0.1.0" }, new StreamableHttpTransport(broker.mcpUrl("history"), { headers: broker.bearer(caller) }), 5_000);
        await client.connect();
        clients.push(client);
        return new HistorySlotStore("history", client);
    }

    beforeAll(async () => {
        broker = await startTestBroker({
            callers: {
                operator: { groups: ["operators-line1"] },
                recorder: { service: "history-recorder" },
                historian: { groups: ["historians"] },
                visitor: {},
            },
            providers: { "mcp-history": { subjects: ["service:mcp-history"], allowedResources: ["/site1/**"] } },
            policy: {
                slotResources: { history: "/site1/history" },
                roles: {
                    caller: { capabilities: ["mcp.tools.call", "mcp.tools.list"] },
                    reader: { capabilities: ["history.read"] },
                    recorder: { capabilities: ["history.record"] },
                    historian: { inherits: ["reader"], capabilities: ["history.admin"] },
                },
                assignments: [
                    { id: "operators-slot", subject: "group:operators-line1", role: "caller", resource: "/site1/history" },
                    { id: "operators-line1", subject: "group:operators-line1", role: "reader", resource: "/site1/line1/**" },
                    { id: "recorder-slot", subject: "service:history-recorder", role: "caller", resource: "/site1/history" },
                    { id: "recorder-site", subject: "service:history-recorder", role: "recorder", resource: "/site1/**" },
                    { id: "historians-slot", subject: "group:historians", role: "caller", resource: "/site1/history" },
                    { id: "historians-site", subject: "group:historians", role: "historian", resource: "/site1/**" },
                    { id: "visitor-slot", subject: "user:visitor", role: "caller", resource: "/site1/history" },
                ],
            },
        });

        const transport = new DirectTransport(broker.providerUrl("history"), { secret: broker.providerSecret("mcp-history") });
        server = new McpServerBuilder()
            .withName("history")
            .withTransport(transport)
            .register(new HistoryBehavior(new MemoryHistoryStore(), new BrokerAccessGuard(transport.broker)))
            .build();
        await server.start();
        const accepted = await transport.broker.declare(buildHistoryDeclaration({ version: "1", namespace: "uns://site1" }));
        expect(accepted.accepted).toBe(true);
    });

    afterAll(async () => {
        for (const client of clients) client.disconnect();
        await server?.stop?.();
        await broker?.stop();
    });

    it("lets the recorder append anywhere in the namespace", async () => {
        const recorder = await as("recorder");
        expect(await recorder.appendAsync([sample(LINE1, 1, 10), sample(LINE2, 1, 20), sample(LINE1, 2, 11)])).toEqual({ accepted: 3, duplicates: 0, rejected: [] });
    });

    it("serves the ids the operator may read and refuses the others one by one", async () => {
        const operator = await as("operator");
        const read = await operator.readRawAsync({ ids: [LINE1, LINE2], start: at(0), end: at(10) });
        expect(read.series.map((item) => item.id)).toEqual([LINE1, LINE2]);
        expect((read.series[0] as IRawSeries).samples.map((item) => item.value)).toEqual([10, 11]);
        const refused = read.series[1]!;
        expect(isSeriesError(refused) && refused.error).toMatchObject({ code: "policy_denied", decisionId: expect.any(String) });
    });

    it("hides from browse what the operator may not read", async () => {
        const operator = await as("operator");
        expect((await operator.browseAsync({ root: "uns://site1" })).items.map((item) => item.id)).toEqual([LINE1]);
    });

    it("refuses an append from a caller without history.record, sample by sample", async () => {
        const operator = await as("operator");
        const result = await operator.appendAsync([sample(LINE1, 3, 12)]);
        expect(result.accepted).toBe(0);
        expect(result.rejected).toEqual([{ index: 0, error: expect.objectContaining({ code: "policy_denied" }) }]);
    });

    it("keeps delete_range for history.admin", async () => {
        const visitor = await as("visitor");
        const refused = await visitor.deleteRangeAsync({ ids: [LINE2], start: at(0), end: at(10) });
        expect(refused.deleted).toBe(0);
        expect(refused.errors).toEqual([expect.objectContaining({ id: LINE2, error: expect.objectContaining({ code: "policy_denied" }) })]);

        const historian = await as("historian");
        expect(await historian.deleteRangeAsync({ ids: [LINE2], start: at(0), end: at(10) })).toEqual({ deleted: 1, errors: [] });
    });
});
