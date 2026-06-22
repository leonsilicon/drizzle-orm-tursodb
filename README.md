# drizzle-orm-tursodb

A [Drizzle ORM](https://orm.drizzle.team) driver for a **local
`tursodb --sync-server`** — an async libsql driver that runs migrations and
transactions **without an explicit `BEGIN`**.

## Why this exists

A local `tursodb --sync-server` runs every `/v2/pipeline` statement inside an
implicit transaction, so the official `drizzle-orm/libsql` driver fails whenever
it emits an explicit `BEGIN`:

```
cannot start a transaction within a transaction
```

The stock `LibSQLSession` emits `BEGIN` in three places — `transaction()`,
`batch()`, and `migrate()`. This package subclasses it (`TursodbSession`) and
overrides exactly those three to run statement-by-statement via
`client.execute(...)`. Everything else (`run`/`all`/`get`/`values`) is inherited
unchanged, since those already issue plain `client.execute` with no transaction
wrapper.

Cloud Turso has no such restriction — keep using the official
`drizzle-orm/libsql` there. Choose by URL with the bundled `isLocalTursoUrl`.

> **Trade-off:** dropping the explicit transaction frame loses per-call
> atomicity. That's safe for sequential writers (no concurrent writer to race)
> and idempotent migration applies (drizzle's `__drizzle_migrations` journal
> skips already-applied tags). Don't use it where you rely on multi-statement
> rollback against a non-loopback server.

## Install

```bash
npm i drizzle-orm-tursodb drizzle-orm @libsql/client
```

`drizzle-orm` and `@libsql/client` are peer dependencies.

## Usage

```ts
import { createClient } from "@libsql/client";
import { drizzle as drizzleCloud } from "drizzle-orm/libsql";
import { drizzle as drizzleTursodb, isLocalTursoUrl } from "drizzle-orm-tursodb";

const url = process.env.DATABASE_URL!;
const client = createClient({ url });

// Local tursodb → transactionless driver; cloud Turso → official driver.
const db = isLocalTursoUrl(url)
  ? drizzleTursodb({ client, schema })
  : drizzleCloud({ client, schema });

await db.insert(users).values({ name: "ada" });
await db.transaction(async (tx) => {
  await tx.insert(users).values({ name: "grace" });
});
```

### Migrations

Use drizzle's own libsql migrator — it goes through `session.migrate(...)`,
which this package overrides to skip the `BEGIN`:

```ts
import { migrate } from "drizzle-orm/libsql/migrator";

await migrate(db, { migrationsFolder: "./drizzle" });
```

## License

MIT
