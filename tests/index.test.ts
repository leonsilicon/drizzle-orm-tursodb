import { expect, test } from "vite-plus/test";
import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle, isLocalTursoUrl } from "../src/index.ts";

const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});

async function makeDb() {
  const client = createClient({ url: ":memory:" });
  const db = drizzle({ client, schema: { users } });
  await db.run(sql`create table users (id integer primary key autoincrement, name text not null)`);
  return db;
}

test("isLocalTursoUrl distinguishes loopback from cloud", () => {
  expect(isLocalTursoUrl("http://127.0.0.1:8080")).toBe(true);
  expect(isLocalTursoUrl("libsql://localhost:8080")).toBe(true);
  expect(isLocalTursoUrl("http://[::1]:8080")).toBe(true);
  expect(isLocalTursoUrl("libsql://my-db.turso.io")).toBe(false);
});

test("drizzle({ client }) runs basic CRUD", async () => {
  const db = await makeDb();
  await db.insert(users).values({ name: "ada" });
  const rows = await db.select().from(users);
  expect(rows).toEqual([{ id: 1, name: "ada" }]);
});

test("transaction() applies writes without an explicit BEGIN", async () => {
  const db = await makeDb();
  await db.transaction(async (tx) => {
    await tx.insert(users).values({ name: "grace" });
    await tx.insert(users).values({ name: "linus" });
  });
  const rows = await db.select().from(users);
  expect(rows).toHaveLength(2);
});

test("batch() runs statements sequentially", async () => {
  const db = await makeDb();
  await db.batch([db.insert(users).values({ name: "a" }), db.insert(users).values({ name: "b" })]);
  const rows = await db.select().from(users);
  expect(rows).toHaveLength(2);
});
