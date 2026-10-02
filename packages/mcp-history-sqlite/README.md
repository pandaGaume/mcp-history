# @cyanmycelium/mcp-history-sqlite

SQLite store for the [history.v1](https://github.com/pandaGaume/mcp-history) contract: UNS-addressed time series in one local file, for a workstation, a bench, or the store-and-forward buffer of a recorder.

```ts
import { HistoryBehavior } from "@cyanmycelium/mcp-history";
import { SqliteHistoryStore } from "@cyanmycelium/mcp-history-sqlite";

const store = new SqliteHistoryStore({ path: "/var/lib/mcp-history/site1.db" });
const behavior = new HistoryBehavior(store, guard, { payload: "structured" });
```

- Every value type (`number`, `boolean`, `string`, `json`), every aggregate, `delete_range`, both read formats (`rows`, `columns`).
- `count`, `min`, `max`, `sum`, `avg` and `goodRatio` are computed by SQLite in one `GROUP BY` per id; `first`, `last` and `timeWeightedAvg` by the contract's reference functions over the rows, only when asked for. It passes the history.v1 conformance suite in memory, on a file, and through an MCP slot.
- WAL mode: readers never wait for the writer. `path: ":memory:"` gives a store that lives as long as the process.
- One table, `history_samples`, that any SQL tool can read as is: `id`, `t_ms` (the time axis, epoch ms), `received_ms`, `source_ms` (null when the protocol carries none), `value_type` (`n`, `b`, `s`, `j`), `value_num`, `value_text`, `quality` (`g`, `u`, `b`), `provider`. The primary key `(id, t_ms, received_ms)` makes appends idempotent.
- A file written with another schema version is refused, never guessed at.

Built on [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) 12 (Node 20 to 26).

License: Apache-2.0.
