import { mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestBroker, type ITestBroker } from "@cyanmycelium/mcp-broker/testing";
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";
import { McpServerBuilder, type IMcpServer, type McpClient } from "@cyanmycelium/mcp-core";
import { BrokerAccessGuard } from "@cyanmycelium/mcp-uns";
import { HistoryBehavior, HistorySlotStore, buildHistoryDeclaration, type IProcessedColumns, type IRawColumns } from "@cyanmycelium/mcp-history";
import { SqliteHistoryStore } from "@cyanmycelium/mcp-history-sqlite";
import { HistoryRecorder, ScadaSlotReader, SqliteRecorderBuffer, type RecorderEvent } from "@cyanmycelium/mcp-history-recorder";
import { MemoryAuditSink } from "@mcp-scada/src/audit/audit";
import { BrokerAuditReporter } from "@mcp-scada/src/broker/broker.audit.reporter";
import { BrokerDecisionClient } from "@mcp-scada/src/broker/broker.decision.client";
import { brokerChannelOf } from "@mcp-scada/src/broker/broker.protocol";
import { ModbusScadaProvider } from "@mcp-scada/src/providers/modbus/modbus.scada.provider";
import { ScadaService } from "@mcp-scada/src/scada.service";
import { ScadaBehavior, brokerCallerResolver } from "@mcp-scada/src/server/scada.behavior";
import { MODBUS_SLOT, ModbusBench, benchAvailable, missingBench, slotClient, until } from "@mcp-scada/tests/live/bench";

/**
 * The recorder in situ: the real motor bench (pyModbusTCP simulator, C++
 * mcp-modbus provider), mcp-scada and the history slot on SQLite, all behind
 * one real broker that decides every read and every append.
 *
 *   simulator ─► bench-motor01 ─► scada ─► recorder ─► history (SQLite)
 */

const NAMESPACE = "uns://production/site1";
const ROOT = "uns://production/site1/line1";
const SPEED = `${ROOT}/motor01/speed`;
const TEMPERATURE = `${ROOT}/motor01/temperature`;
const RUNNING = `${ROOT}/motor01/running`;
const SIMULATOR_PORT = 15020;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Modbus TCP function 6, write single holding register: what an operator panel would do to the motor. */
async function writeRegister(address: number, value: number): Promise<void> {
    const frame = Buffer.alloc(12);
    frame.writeUInt16BE(1, 0); // transaction
    frame.writeUInt16BE(0, 2); // protocol
    frame.writeUInt16BE(6, 4); // length: unit + PDU
    frame.writeUInt8(1, 6); // unit
    frame.writeUInt8(6, 7); // function
    frame.writeUInt16BE(address, 8);
    frame.writeUInt16BE(value, 10);
    await new Promise<void>((resolve, reject) => {
        const socket = new Socket();
        socket.once("error", reject);
        socket.connect(SIMULATOR_PORT, "127.0.0.1", () => socket.write(frame));
        socket.once("data", (answer) => {
            socket.destroy();
            answer.readUInt8(7) === 6 ? resolve() : reject(new Error(`modbus exception ${answer.readUInt8(8)}`));
        });
    });
}

if (!benchAvailable) console.warn(`[recorder live] skipped, missing: ${missingBench.join(", ")}`);

describe.skipIf(!benchAvailable)("the recorder on the live motor bench, through a real broker", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-history-live-"));
    let broker: ITestBroker;
    let bench: ModbusBench;
    let scadaTransport: DirectTransport;
    let historyTransport: DirectTransport;
    let historyServer: IMcpServer;
    let historyStore: SqliteHistoryStore;
    let recorder: HistoryRecorder;
    const events: RecorderEvent[] = [];
    const clients: McpClient[] = [];

    const connect = async (slot: string, caller: string) => {
        const client = slotClient(slot, { port: Number(new URL(broker.url).port), headers: broker.bearer(caller) });
        await client.connect();
        clients.push(client);
        return client;
    };

    /** The history slot, as its own provider: started at setup, stopped and restarted to test the buffer. */
    const startHistorySlot = async () => {
        historyTransport = new DirectTransport(broker.providerUrl("history"), { secret: broker.providerSecret("mcp-history") });
        historyServer = new McpServerBuilder()
            .withName("history")
            .withTransport(historyTransport)
            .register(new HistoryBehavior(historyStore, new BrokerAccessGuard(historyTransport.broker), { payload: "structured" }))
            .build();
        await historyServer.start();
        await until("history declaration", () => historyTransport.broker.declare(buildHistoryDeclaration({ version: "bench-1", namespace: NAMESPACE })));
    };

    const operatorView = async () => new HistorySlotStore("history", await connect("history", "operator"));
    const span = { start: new Date(Date.now() - 3_600_000).toISOString(), end: new Date(Date.now() + 3_600_000).toISOString() };
    const raw = async (id: string) => (await (await operatorView()).readRawAsync({ ids: [id], ...span, format: "columns" })).series[0] as IRawColumns;

    beforeAll(async () => {
        broker = await startTestBroker({
            callers: {
                scada: { service: "mcp-scada" },
                recorder: { service: "history-recorder" },
                operator: { groups: ["operators"] },
            },
            providers: {
                "mcp-scada": { subjects: ["service:mcp-scada"], allowedResources: ["/production/site1/**"] },
                "mcp-history": { subjects: ["service:mcp-history"], allowedResources: ["/production/site1/**"] },
                "modbus-bench": { allowedResources: ["/production/site1/line1/**"] },
            },
            protectedSlots: { [MODBUS_SLOT]: { declaredBy: "mcp-scada", publishedBy: "modbus-bench" } },
            policy: {
                slotResources: { scada: "/production/site1/scada", history: "/production/site1/history", [MODBUS_SLOT]: "/production/site1/line1/motor01-slot" },
                roles: {
                    caller: { capabilities: ["mcp.tools.call", "mcp.tools.list", "mcp.resources.read"] },
                    recorder: { inherits: ["caller"], capabilities: ["scada.observe", "scada.acquire", "history.record"] },
                    reader: { inherits: ["caller"], capabilities: ["history.read"] },
                },
                assignments: [
                    { id: "scada-reads-modbus", subject: "service:mcp-scada", role: "caller", resource: "/production/site1/line1/**" },
                    { id: "recorder-site", subject: "service:history-recorder", role: "recorder", resource: "/production/site1/**" },
                    { id: "operators-read-history", subject: "group:operators", role: "reader", resource: "/production/site1/**" },
                ],
            },
        });
        const port = Number(new URL(broker.url).port);

        bench = new ModbusBench({ brokerPort: port, embeddedBroker: false, providerToken: broker.providerSecret("modbus-bench") });
        await bench.start();
        await until("motor speed register", () => writeRegister(0, 1450));

        // mcp-scada, published as `scada`, deciding through the broker.
        const modbus = await until("modbus slot", async () => {
            const client = slotClient(MODBUS_SLOT, { port, headers: broker.bearer("scada") });
            try {
                await client.connect();
                const probe = await client.callTool("modbus.read", { device: "motor01", binding: "speed", timeoutMs: 500 });
                if (probe.isError) throw new Error(JSON.stringify(probe.content));
                return client;
            } catch (error) {
                client.disconnect();
                throw error;
            }
        });
        clients.push(modbus);
        scadaTransport = new DirectTransport(broker.providerUrl("scada"), { secret: broker.providerSecret("mcp-scada") });
        const channel = brokerChannelOf(scadaTransport.broker);
        const gate = new BrokerDecisionClient(channel);
        const service = new ScadaService({ policy: gate, audit: new BrokerAuditReporter(channel, new MemoryAuditSink()) });
        await service.registerProviderAsync(new ModbusScadaProvider({ id: "modbus-bench", client: modbus, root: ROOT, source: "device", timeoutMs: 1_000 }), ROOT);
        await new McpServerBuilder().withName("mcp-scada").withTransport(scadaTransport).register(new ScadaBehavior(service, brokerCallerResolver())).build().start();
        await until("scada declaration", () => gate.declareAsync(service.buildDeclaration({ version: "bench-1", namespace: NAMESPACE, protects: [MODBUS_SLOT] })));

        // The history slot on a SQLite file.
        historyStore = new SqliteHistoryStore({ path: join(dir, "history.db") });
        await startHistorySlot();

        // The recorder: one more caller of both slots, with its own identity.
        recorder = new HistoryRecorder({
            reader: new ScadaSlotReader(await connect("scada", "recorder"), { destination: "source" }),
            sink: new HistorySlotStore("history", await connect("history", "recorder")),
            buffer: new SqliteRecorderBuffer(join(dir, "buffer.db")),
            tags: [
                { id: SPEED, periodMs: 200, mode: "on-change" },
                { id: TEMPERATURE, periodMs: 500 },
                { id: RUNNING, periodMs: 200, mode: "on-change" },
            ],
            flushIntervalMs: 300,
            retryMaxMs: 1_000,
            onEvent: (event) => events.push(event),
        });
    });

    afterAll(async () => {
        const errors = new Map<string, number>();
        for (const event of events)
            if (event.type === "read-error" || event.type === "read-failed")
                errors.set(`${event.type} ${"code" in event ? event.code : event.reason}`, (errors.get(`${event.type} ${"code" in event ? event.code : event.reason}`) ?? 0) + 1);
        console.log("[recorder live] read errors:", JSON.stringify([...errors]));
        await recorder?.closeAsync();
        for (const client of clients) client.disconnect();
        scadaTransport?.close();
        historyTransport?.close();
        await bench?.stop();
        await broker?.stop();
        await historyStore?.closeAsync();
        rmSync(dir, { recursive: true, force: true });
    });

    it("records the motor as it runs: speed on change, temperature periodically", async () => {
        recorder.start();
        await sleep(1_200);
        await writeRegister(0, 1500);
        await sleep(600);
        await writeRegister(0, 1520);
        await sleep(800);
        await recorder.flushAsync({ force: true });

        const speed = await raw(SPEED);
        expect(speed.value).toEqual([1450, 1500, 1520]);
        expect(new Set(speed.quality)).toEqual(new Set(["good"]));
        expect(new Set(speed.provider)).toEqual(new Set(["modbus-bench"]));
        // Modbus carries no source timestamp: filed under reception, never synthesized.
        expect(speed.sourceTimestamp.every((value) => value === null)).toBe(true);
        expect(speed.time).toEqual(speed.receivedTimestamp);

        const temperature = await raw(TEMPERATURE);
        expect(temperature.value.length).toBeGreaterThanOrEqual(4);
        expect(new Set(temperature.value)).toEqual(new Set([523]));
        expect((await raw(RUNNING)).value).toEqual([true]);
    });

    it("records an unreachable motor as bad, once, and its return as good", async () => {
        bench.stopSimulator();
        await sleep(2_500);
        bench.startSimulator();
        await until("motor back", () => writeRegister(0, 1520));
        await sleep(1_500);
        await recorder.flushAsync({ force: true });

        const speed = await raw(SPEED);
        const tail = speed.quality.slice(3);
        expect(tail[0]).toBe("bad");
        expect(tail.at(-1)).toBe("good");
        // On change: the outage is one sample, not one per read.
        expect(tail.filter((quality) => quality === "bad")).toHaveLength(1);
        expect(speed.value[speed.value.length - 1]).toBe(1520);
    });

    it("keeps recording while the history slot is down, and replays the buffer when it is back", async () => {
        historyTransport.close();
        await sleep(300);
        await writeRegister(0, 1600);
        await sleep(800);
        await writeRegister(0, 1610);
        await sleep(800);
        const during = await recorder.statsAsync();
        expect(during.buffered).toBeGreaterThan(0);
        expect(during.lastFlushError).not.toBeNull();
        expect(events.some((event) => event.type === "flush-failed")).toBe(true);

        await startHistorySlot();
        await until("buffer drained", async () => {
            await recorder.flushAsync({ force: true });
            const stats = await recorder.statsAsync();
            if (stats.buffered > 0) throw new Error(`${stats.buffered} samples still buffered`);
        });

        const speed = await raw(SPEED);
        expect(speed.value.slice(-2)).toEqual([1600, 1610]);
        const stats = await recorder.statsAsync();
        expect(stats.rejected).toBe(0);
        expect(stats.appended).toBe(stats.recorded - stats.buffered);
    });

    it("serves the recording back as aggregates, to a reader the broker allows", async () => {
        await recorder.stopAsync();
        const view = await operatorView();
        const processed = await view.readProcessedAsync({
            ids: [TEMPERATURE, SPEED],
            ...span,
            intervalMs: 3_600_000,
            aggregates: ["count", "avg", "max", "goodRatio"],
            format: "columns",
        });
        const [temperature, speed] = processed.series as IProcessedColumns[];
        expect(temperature!.values.avg!.find((value) => value !== null)).toBe(523);
        expect(speed!.values.max!.find((value) => value !== null)).toBe(1610);
        const ratio = speed!.values.goodRatio!.find((value) => value !== null) as number;
        expect(ratio).toBeGreaterThan(0);
        expect(ratio).toBeLessThan(1);

        const browse = await view.browseAsync({ root: ROOT });
        expect(browse.items.map((item) => item.id)).toEqual([RUNNING, SPEED, TEMPERATURE]);
    });
});
