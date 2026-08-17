import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'

import * as schema from '@/db/schema'

type TestDatabase = { db: PgliteDatabase<typeof schema>; client: PGlite }

const MIGRATIONS_DIR = join(process.cwd(), 'db/migrations')
const CACHE_DIR = join(process.cwd(), 'node_modules/.cache/fiuba-tps')

/**
 * One database per test file, emptied between tests.
 *
 * Vitest isolates each test file in its own process, so this module-level
 * instance is per file: the first `beforeEach` restores it, and every later
 * one truncates. Measured on this schema: restoring the template costs
 * **130 ms** and truncating all 16 tables costs **11 ms**. Rebuilding per test
 * instead spent ~135 s of CPU on setup alone, which is what pegged every core
 * for the length of a run.
 *
 * `RESTART IDENTITY` is what keeps this equivalent to a fresh database rather
 * than merely close to one: the sequences go back to 1, so the tests that
 * assert on absolute counts and on ids read the same as they did before.
 */
let instance: TestDatabase | undefined
let truncateAll: string | undefined

/**
 * A real Postgres for the tests, in-process.
 *
 * Mocking drizzle's builder would test the mock. The behaviours the specs
 * below care about — the unique indexes, the partial `WHERE deleted_at IS
 * NULL`, the rollback of the transaction — only exist in the database, so the
 * generated migrations are applied as-is and exercised for real.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  if (instance) {
    await instance.client.exec(truncateAll!)
    return instance
  }

  const client = new PGlite({ loadDataDir: new Blob([await template()]) })
  await client.waitReady
  const db = drizzle(client, { schema })

  // Built from the catalogue rather than from a hand-kept list, so a table
  // added in a later migration is emptied without anybody remembering to come
  // back here — and a forgotten one is exactly the kind of leak that makes a
  // suite pass alone and fail in a full run.
  const tables = await client.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public'`,
  )

  truncateAll = `truncate ${tables.rows
    .map((row) => `"${row.tablename}"`)
    .join(', ')} restart identity cascade`

  instance = { db, client }
  return instance
}

/**
 * The migrated database, as a tarball to restore from instead of building.
 *
 * `initdb` is 590 ms of the 642 ms a fresh migrated database costs — the
 * migrations themselves are 53 — and restoring a dump of the very same
 * database is 130 ms. With fifteen files in fifteen processes that difference
 * is the whole reason a run used to pin every core.
 *
 * Cached on disk and keyed by the **contents** of db/migrations, so a new or
 * edited migration builds a new template and the stale one is simply never
 * asked for again. Built lazily rather than in a `globalSetup`: a setup hook
 * runs on every invocation, and it took `vitest run test/slug.test.ts` — a
 * file that touches no database — from 0.45 s to 1.50 s, which is exactly the
 * run one makes over and over while iterating.
 *
 * Two workers racing on a cold cache both build it and both write; the rename
 * is atomic, so one wins and the other's copy is discarded. That costs a
 * duplicated build once, against a lock that would have to be got right.
 */
async function template(): Promise<Uint8Array<ArrayBuffer>> {
  const sources = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))

  const digest = createHash('sha256').update(sources.join('\n')).digest('hex').slice(0, 16)
  const path = join(CACHE_DIR, `pglite-${digest}.tar`)

  // Copied into a plain ArrayBuffer: a Buffer's may be shared, which Blob rejects
  if (existsSync(path)) return Uint8Array.from(readFileSync(path))

  const client = new PGlite()

  // The generated migrations, applied as-is: the behaviours the suite cares
  // about — the unique indexes, the partial `WHERE deleted_at IS NULL`, the
  // rollback of a transaction — only exist in the database.
  for (const sql of sources) {
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) await client.exec(statement)
    }
  }

  const dump = new Uint8Array(await (await client.dumpDataDir('none')).arrayBuffer())
  await client.close()

  // Written aside and renamed, which is atomic on one filesystem: two workers
  // racing on a cold cache both build and both write, one wins, and nobody
  // ever reads a half-written tarball.
  mkdirSync(CACHE_DIR, { recursive: true })
  const scratch = `${path}.${process.pid}`
  writeFileSync(scratch, dump)
  renameSync(scratch, path)

  return dump
}
