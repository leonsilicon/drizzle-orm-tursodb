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

const notes = sqliteTable("notes", {
  id: integer("id").primaryKey(),
  pinned: integer("pinned", { mode: "boolean" }).notNull(),
  settings: text("settings", { mode: "json" }).$type<{ theme: string }>().notNull(),
});

test("decodes booleans and JSON through drizzle's codecs, in queries and batches", async () => {
  const client = createClient({ url: ":memory:" });
  const db = drizzle({ client });
  await db.run(
    sql`create table notes (id integer primary key, pinned integer not null, settings text not null)`,
  );
  await db.insert(notes).values([
    { id: 1, pinned: true, settings: { theme: "dark" } },
    { id: 2, pinned: false, settings: { theme: "light" } },
  ]);

  // drizzle-orm 1.0.0-rc.5 decodes these in the dialect's codecs: without them, 1 and a JSON string.
  expect(
    await db
      .select()
      .from(notes)
      .where(sql`id = 1`),
  ).toEqual([{ id: 1, pinned: true, settings: { theme: "dark" } }]);

  const [all, second] = await db.batch([
    db.select().from(notes),
    db
      .select({ settings: notes.settings })
      .from(notes)
      .where(sql`id = 2`),
  ]);
  expect(all).toEqual([
    { id: 1, pinned: true, settings: { theme: "dark" } },
    { id: 2, pinned: false, settings: { theme: "light" } },
  ]);
  expect(second).toEqual([{ settings: { theme: "light" } }]);
});
