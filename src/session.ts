// A "local tursodb" variant of drizzle's official async libsql session
// (`drizzle-orm/libsql/session` → `LibSQLSession`). It exists for ONE reason:
// the local `tursodb --sync-server` (Turso 0.6.x) runs every `/v2/pipeline`
// statement inside an implicit transaction, so any explicit `BEGIN` fails with
// `cannot start a transaction within a transaction`.
//
// The official session emits a `BEGIN` in three places, all of which this
// subclass overrides to run statement-by-statement via `client.execute`
// instead:
//   - `transaction(cb)` → `client.transaction()` (opens a libsql tx → BEGIN)
//   - `batch(queries)`  → `client.batch(…)` (hrana batch prepends BEGIN)
//   - `migrate(queries)`→ `client.migrate(…)` (`executeHranaBatch` prepends BEGIN)
//
// Everything else — `prepareQuery` and the whole `LibSQLPreparedQuery` surface
// (`run`/`all`/`get`/`values`) — is inherited UNCHANGED, because those already
// issue plain `client.execute({ sql, args })` with no transaction wrapper.
//
// Cloud Turso has no such restriction and keeps the stock `LibSQLSession`
// (atomic batches / real transactions). Pick this session only for a local
// loopback Turso URL (see `isLocalTursoUrl`).
//
// Losing per-call atomicity on local tursodb is safe for sequential writers
// (no concurrent writer to race) and idempotent migration applies (drizzle's
// `__drizzle_migrations` journal skips already-applied tags).

import type * as V1 from "drizzle-orm/_relations";
import { entityKind, type AnyRelations } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Client, InArgs } from "@libsql/client";
import { LibSQLSession, LibSQLTransaction } from "drizzle-orm/libsql/session";
// rc.4: the sync/async dialect pair collapsed into a single `SQLiteDialect`.
import type { BatchResponse } from "drizzle-orm/batch";
import type { SQLiteAsyncPreparedQuery, SQLiteDialect } from "drizzle-orm/sqlite-core";

type SQLiteBatchItem = BatchItem<"sqlite">;

/** The prepared-query surface the base `batch`/`migrate` rely on. */
interface PreparableQuery {
  // rc.4 removed `LibSQLPreparedQuery`; the prepared query is a `SQLiteAsyncPreparedQuery` now, and
  // this is a structural shape rather than a nominal one.
  _prepare: () => SQLiteAsyncPreparedQuery<never> & {
    getQuery: () => { params: unknown[]; sql: string };
    mapResult: (response: unknown, isFromBatch?: boolean) => unknown;
  };
}

function asPreparable(query: SQLiteBatchItem): PreparableQuery {
  // drizzle's batch items all expose `_prepare()`; the public `BatchItem` type
  // doesn't surface it, so narrow structurally rather than reaching for `any`.
  const candidate = query as unknown as Partial<PreparableQuery>;
  if (typeof candidate._prepare !== "function") {
    throw new TypeError("Batch item is not a preparable drizzle query");
  }
  return candidate as PreparableQuery;
}

/**
 * Runs each query's built statement through `client.execute` in order — the
 * transactionless equivalent of the base session's `client.batch` /
 * `client.migrate`. Reuses drizzle's own `_prepare()` / `getQuery()` /
 * `mapResult()` so result shaping stays identical to a real batch
 * (`isFromBatch = true`).
 */
async function runStatementsSequentially(
  client: Client,
  queries: readonly SQLiteBatchItem[],
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const query of queries) {
    const prepared = asPreparable(query)._prepare();
    const built = prepared.getQuery();
    const result = await client.execute({
      args: built.params as InArgs,
      sql: built.sql,
    });
    results.push(prepared.mapResult(result, true));
  }
  return results;
}

export class TursodbSession<
  TFullSchema extends Record<string, unknown>,
  TRelations extends AnyRelations,
  TSchema extends V1.TablesRelationalConfig,
  // rc.4: `LibSQLSession<TRelations>` — the `TFullSchema`/`TSchema` generics were dropped.
> extends LibSQLSession<TRelations> {
  static override readonly [entityKind]: string = "TursodbSession";

  // The base stores `dialect` as an `@internal` constructor param-property,
  // which isn't visible to subclasses through the public typings. Keep our own
  // reference so `transaction(...)` can build a `LibSQLTransaction`.
  private readonly localDialect: SQLiteDialect;

  constructor(
    private localClient: Client,
    dialect: SQLiteDialect,
    private localRelations: TRelations,
    // Kept as a plain PARAMETER, not a field: rc.4 no longer threads a schema config anywhere, so
    // storing it left it provably unread. The ctor position stays for API compatibility.
    localSchema: V1.RelationalSchemaConfig<TSchema> | undefined,
    // rc.4 ctor: (client, dialect, relations, options, tx) — `schema` was removed, so `options`
    // moved from index 4 to index 3.
    options: ConstructorParameters<typeof LibSQLSession>[3],
  ) {
    // `tx = undefined`: this session never runs inside a libsql Transaction
    // handle (that is exactly the BEGIN we are avoiding).
    super(localClient, dialect, localRelations, options, undefined);
    this.localDialect = dialect;
  }

  // rc.4 types these as `Promise<BatchResponse<T>>`. This driver deliberately runs the statements
  // SEQUENTIALLY (tursodb cannot run libsql's batched BEGIN), and the caller only consumes the row
  // arrays, so assert to the declared shape rather than widen the base's contract.
  async batch<T extends SQLiteBatchItem[] | readonly SQLiteBatchItem[]>(
    queries: T,
  ): Promise<BatchResponse<T>> {
    return (await runStatementsSequentially(this.localClient, queries)) as BatchResponse<T>;
  }

  async migrate<T extends SQLiteBatchItem[] | readonly SQLiteBatchItem[]>(
    queries: T,
  ): Promise<BatchResponse<T>> {
    return (await runStatementsSequentially(this.localClient, queries)) as BatchResponse<T>;
  }

  override async transaction<T>(
    transaction: (tx: LibSQLTransaction<TRelations>) => T | Promise<T>,
  ): Promise<T> {
    // No `begin`/`commit` — run the callback against a transaction view backed
    // by this same (autocommitting) session. Local tursodb already wraps each
    // statement implicitly, so the writes still land; we just skip the explicit
    // transaction frame it rejects.
    const tx = new LibSQLTransaction<TRelations>(
      "async",
      this.localDialect,
      this,
      // rc.4 dropped the trailing `schema` argument (the next slot is `nestedIndex: number`).
      this.localRelations,
    );
    return await transaction(tx);
  }
}
