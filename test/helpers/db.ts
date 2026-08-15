import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'

import * as schema from '@/db/schema'

const MIGRATIONS_DIR = join(process.cwd(), 'db/migrations')

type TestDatabase = { db: PgliteDatabase<typeof schema>; client: PGlite }

/**
 * One database per test file, emptied between tests.
 *
 * Vitest isolates each test file in its own worker, so this module-level
 * instance is per file: the first `beforeEach` builds it, and every later one
 * truncates. Measured on this schema: building costs **650 ms** — a fresh
 * PGlite plus the seven migrations — and truncating all 16 tables costs
 * **11 ms**. With 207 database-backed tests, rebuilding per test spent ~135 s
 * of CPU on setup alone, which is what pegged every core for the length of a
 * run.
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

  const client = new PGlite()
  const db = drizzle(client, { schema })

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) await client.exec(statement)
    }
  }

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
