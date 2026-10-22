// `drizzle(...)` — the "local tursodb" twin of drizzle's official
// `drizzle-orm/libsql` driver. Identical construction (same dialect, schema/
// relations extraction, `LibSQLDatabase`), except it injects a `TursodbSession`
// instead of the stock `LibSQLSession` so migrations and `.transaction(...)`
// run WITHOUT an explicit `BEGIN` (which local `tursodb --sync-server` rejects).
// See `session.ts`.
//
// Drizzle doesn't expose a session-injection hook on its `drizzle()` factory,
// so this re-implements the ~15-line `construct()` body from
// `drizzle-orm/libsql/driver-core`. Cloud Turso should continue to use the
// official `drizzle` from `drizzle-orm/libsql`; pick between them by URL (see
// `isLocalTursoUrl`).

import { DefaultLogger, type AnyRelations, type EmptyRelations, type Logger } from "drizzle-orm";
import * as V1 from "drizzle-orm/_relations";
import type { Client, ResultSet } from "@libsql/client";
import { libsqlCodecs } from "drizzle-orm/libsql/codecs";
import { LibSQLDatabase } from "drizzle-orm/libsql/driver-core";
// drizzle-orm 1.0.0-rc.4 collapsed the sync/async dialects into one `SQLiteDialect`, and moved the
// session class into the `async/` namespace as `SQLiteAsyncSession`.
import {
  SQLiteDialect,
  type DrizzleSQLiteConfig,
  type SQLiteAsyncSession,
} from "drizzle-orm/sqlite-core";

import { TursodbSession } from "./session.ts";

export type TursodbDrizzleConfig<
  TSchema extends Record<string, unknown>,
  TRelations extends AnyRelations,
> = DrizzleSQLiteConfig<TRelations> & { client: Client; schema?: TSchema | undefined };

export function drizzle<
  TSchema extends Record<string, unknown> = Record<string, never>,
  TRelations extends AnyRelations = EmptyRelations,
>(
  config: TursodbDrizzleConfig<TSchema, TRelations>,
): LibSQLDatabase<TRelations> & { $client: Client } {
  const { client, ...drizzleConfig } = config;
  // drizzle-orm 1.0.0-rc.5 moved value decoding (integer booleans, `text` JSON, timestamps, blobs and
  // their in-JSON casts) from the column classes into dialect codecs, which `drizzle-orm/libsql`
  // passes as `libsqlCodecs`. Without them booleans read back as 0/1 and JSON columns as strings.
  const dialect = new SQLiteDialect({ codecs: drizzleConfig.codecs ?? libsqlCodecs });

  let logger: Logger | undefined;
  if (drizzleConfig.logger === true) {
    logger = new DefaultLogger();
  } else if (drizzleConfig.logger !== false) {
    logger = drizzleConfig.logger;
  }

  let schema: V1.RelationalSchemaConfig<V1.ExtractTablesWithRelations<TSchema>> | undefined;
  if (drizzleConfig.schema) {
    const tablesConfig = V1.extractTablesRelationalConfig(
      drizzleConfig.schema,
      V1.createTableRelationsHelpers,
    );
    schema = {
      fullSchema: drizzleConfig.schema,
      schema: tablesConfig.tables as V1.ExtractTablesWithRelations<TSchema>,
      tableNamesMap: tablesConfig.tableNamesMap,
    };
  }

  const relations = (drizzleConfig.relations ?? {}) as TRelations;
  const session = new TursodbSession<TSchema, TRelations, V1.ExtractTablesWithRelations<TSchema>>(
    client,
    dialect,
    relations,
    schema,
    {
      cache: drizzleConfig.cache,
      logger,
      paramsInErrors: drizzleConfig.paramsInErrors,
    },
  );

  const db = new LibSQLDatabase<TRelations>(
    "async",
    dialect,
    // `TursodbSession` is a `LibSQLSession` subclass, hence structurally the
    // `SQLiteSession` the database constructor wants; the explicit generic just
    // restates that for the type checker.
    // rc.4: SQLiteAsyncSession<TResultKind, TRunResult, TRelations>; the database ctor also dropped
    // its trailing `schema` argument.
    session as SQLiteAsyncSession<"async", ResultSet, TRelations>,
    relations,
  ) as LibSQLDatabase<TRelations> & { $client: Client };
  db.$client = client;
  return db;
}
