import { LoopbackTransport, McpClient, McpServerBuilder } from "@cyanmycelium/mcp-core";
import { HistoryBehavior, HistorySlotStore, MemoryHistoryStore, type IHistoryStore } from "@cyanmycelium/mcp-history";
import { openGuard } from "@cyanmycelium/mcp-uns";
import { describeHistoryStoreConformance } from "@cyanmycelium/mcp-history/conformance";

describeHistoryStoreConformance("MemoryHistoryStore", () => new MemoryHistoryStore());

/** A store published by HistoryBehavior, reached back through MCP: the two forms of the contract must agree. */
async function throughSlot(store: IHistoryStore, payload: "both" | "structured" = "both"): Promise<IHistoryStore> {
    const [serverEnd, clientEnd] = LoopbackTransport.createPair();
    const server = new McpServerBuilder()
        .withName("history")
        .withTransport(serverEnd)
        .register(new HistoryBehavior(store, openGuard(), { payload }))
        .build();
    await server.start();
    const client = new McpClient({ name: "conformance", version: "0.1.0" }, clientEnd, 5_000);
    await client.connect();
    const remote = new HistorySlotStore("history", client);
    return {
        id: remote.id,
        getCapabilitiesAsync: (signal) => remote.getCapabilitiesAsync(signal),
        appendAsync: (samples, signal) => remote.appendAsync(samples, signal),
        readRawAsync: (request, signal) => remote.readRawAsync(request, signal),
        readProcessedAsync: (request, signal) => remote.readProcessedAsync(request, signal),
        readAtTimeAsync: (request, signal) => remote.readAtTimeAsync(request, signal),
        browseAsync: (request, signal) => remote.browseAsync(request, signal),
        deleteRangeAsync: (request, signal) => remote.deleteRangeAsync(request, signal),
        async closeAsync() {
            client.disconnect();
            await store.closeAsync();
        },
    };
}

describeHistoryStoreConformance("MemoryHistoryStore through a history slot", () => throughSlot(new MemoryHistoryStore()));
describeHistoryStoreConformance("MemoryHistoryStore through a history slot, structuredContent only", () => throughSlot(new MemoryHistoryStore(), "structured"));
