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
import {
  LibSQLSession,
  LibSQLTransaction,
  type LibSQLPreparedQuery,
} from "drizzle-orm/libsql/session";
import type { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";

type SQLiteBatchItem = BatchItem<"sqlite">;

/** The prepared-query surface the base `batch`/`migrate` rely on. */
interface PreparableQuery {
  _prepare: () => LibSQLPreparedQuery & {
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
> extends LibSQLSession<TFullSchema, TRelations, TSchema> {
  static override readonly [entityKind]: string = "TursodbSession";

  // The base stores `dialect` as an `@internal` constructor param-property,
  // which isn't visible to subclasses through the public typings. Keep our own
  // reference so `transaction(...)` can build a `LibSQLTransaction`.
  private readonly localDialect: SQLiteAsyncDialect;

  constructor(
    private localClient: Client,
    dialect: SQLiteAsyncDialect,
    private localRelations: TRelations,
    private localSchema: V1.RelationalSchemaConfig<TSchema> | undefined,
    options: ConstructorParameters<typeof LibSQLSession>[4],
  ) {
    // `tx = undefined`: this session never runs inside a libsql Transaction
    // handle (that is exactly the BEGIN we are avoiding).
    super(localClient, dialect, localRelations, localSchema, options, undefined);
    this.localDialect = dialect;
  }

  override async batch<T extends SQLiteBatchItem[] | readonly SQLiteBatchItem[]>(
    queries: T,
  ): Promise<unknown[]> {
    return runStatementsSequentially(this.localClient, queries);
  }

  override async migrate<T extends SQLiteBatchItem[] | readonly SQLiteBatchItem[]>(
    queries: T,
  ): Promise<unknown[]> {
    return runStatementsSequentially(this.localClient, queries);
  }

  override async transaction<T>(
    transaction: (tx: LibSQLTransaction<TFullSchema, TRelations, TSchema>) => T | Promise<T>,
  ): Promise<T> {
    // No `begin`/`commit` — run the callback against a transaction view backed
    // by this same (autocommitting) session. Local tursodb already wraps each
    // statement implicitly, so the writes still land; we just skip the explicit
    // transaction frame it rejects.
    const tx = new LibSQLTransaction<TFullSchema, TRelations, TSchema>(
      "async",
      this.localDialect,
      this,
      this.localRelations,
      this.localSchema,
    );
    return await transaction(tx);
  }
}
