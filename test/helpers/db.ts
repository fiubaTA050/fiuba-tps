import { readFileSync } from 'node:fs'

import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { inject } from 'vitest'

import * as schema from '@/db/schema'

type TestDatabase = { db: PgliteDatabase<typeof schema>; client: PGlite }

/**
 * One database per test file, emptied between tests.
 *
 * Vitest isolates each test file in its own worker, so this module-level
 * instance is per file: the first `beforeEach` restores it, and every later
 * one truncates. Measured on this schema: restoring the template costs
 * **130 ms** and truncating all 16 tables costs **11 ms**. Rebuilding per test
 * instead spent ~135 s of CPU on setup alone, which is what pegged every core
 * for the length of a run.
 *
 * It restores rather than builds: `initdb` is 590 ms of the 642 ms a fresh
 * migrated database costs, and test/helpers/global-setup.ts pays it once for
 * the whole run instead of once per file.
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
 * generated migration is applied as-is and exercised for real.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  if (instance) {
    await instance.client.exec(truncateAll!)
    return instance
  }

  const client = new PGlite({ loadDataDir: new Blob([readFileSync(inject('pgliteTemplate'))]) })
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
