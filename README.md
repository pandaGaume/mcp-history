<p align="center">
  <img src="https://raw.githubusercontent.com/pandaGaume/mcp-history/main/docs/assets/logo.png" alt="mcp-history logo: the network-discovery panda holding an hourglass, a time series glowing on its chest" width="180">
</p>

# mcp-history

History slots for an [mcp-broker](https://github.com/pandaGaume/mcp-broker): one contract, `history.v1`, for recording and reading back SCADA values, addressed by UNS id, with pluggable stores.

```text
MCP client ──> mcp-broker ──> slot "history" (HistoryBehavior)
                                  │  one broker decision per UNS id, audited
                                  └──> IHistoryStore: memory today; SQLite, DuckDB, MySQL next
```

The contract has two forms that say the same thing:

- `IHistoryStore`, the TypeScript interface a backend implements;
- the `history.*` MCP tools, which `HistoryBehavior` derives from any implementation.

`HistorySlotStore` reaches a slot back as an `IHistoryStore`, and the conformance suite runs unchanged on both forms.

Design and decisions: [docs/brief_history_slot.md](https://github.com/pandaGaume/mcp-history/blob/main/docs/brief_history_slot.md) (French).

## Use

```ts
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";
import { McpServerBuilder } from "@cyanmycelium/mcp-core";
import { HistoryBehavior, MemoryHistoryStore, buildHistoryDeclaration } from "@cyanmycelium/mcp-history";
import { BrokerAccessGuard } from "@cyanmycelium/mcp-uns";

const transport = new DirectTransport("ws://localhost:3000/provider/history", { secret });
const server = new McpServerBuilder()
    .withName("history")
    .withTransport(transport)
    .register(new HistoryBehavior(new MemoryHistoryStore(), new BrokerAccessGuard(transport.broker)))
    .build();
await server.start();
await transport.broker.declare(buildHistoryDeclaration({ version: "1", namespace: "uns://site1" }));
```

UNS ids and broker-decided access come from [mcp-uns](https://github.com/pandaGaume/mcp-uns). `new HistoryBehavior(store, guard, { payload: "structured" })` sends each result once, as `structuredContent`: with `format: "columns"`, reads are 4 to 7 times smaller. On a bench without broker policy, pass its `openGuard()` instead of `BrokerAccessGuard`: everything is allowed and nothing is audited.

## Tools

| tool | broker capability, checked per id |
|---|---|
| `history.capabilities` | none |
| `history.browse` | `history.read` (ids you may not read are left out) |
| `history.read_raw`, `history.read_processed`, `history.read_at_time` | `history.read` (`format: "columns"` on the first two: parallel arrays, epoch ms) |
| `history.append` | `history.record`, outcome reported |
| `history.delete_range` | `history.admin`, outcome reported |

## Packages

| package | what |
|---|---|
| `@cyanmycelium/mcp-history` | the contract, `MemoryHistoryStore`, `HistoryBehavior`, `HistorySlotStore`, the declaration, and the conformance suite under `/conformance` |
| `@cyanmycelium/mcp-history-sqlite` | `SqliteHistoryStore`: one local file, aggregated in SQL |

## Writing a store

Implement `IHistoryStore`, then prove it:

```ts
import { describeHistoryStoreConformance } from "@cyanmycelium/mcp-history/conformance";

describeHistoryStoreConformance("SqliteHistoryStore", () => new SqliteHistoryStore({ path: ":memory:" }));
```

The suite pins the shared semantics: time axis, idempotent append, `[start, end)` ranges, paging, every aggregate, at-time reads, browse by whole UNS segments, delete, request validation. `computeBuckets` and `valueAtTime` in the contract are the reference implementations; a backend that computes natively must give the same results.

## Develop

```sh
npm install
npm run typecheck
npm test
npm run build
```

Tests run against the sources. `tests/broker.test.ts` starts a real broker with `@cyanmycelium/mcp-broker/testing`; it needs no network beyond `127.0.0.1`.

## License

Apache-2.0.
