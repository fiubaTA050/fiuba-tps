import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

import * as schema from '@/db/schema'

const MIGRATIONS_DIR = join(process.cwd(), 'db/migrations')

/**
 * A real Postgres for the tests, in-process.
 *
 * Mocking drizzle's builder would test the mock. The behaviours the specs
 * below care about — the unique indexes, the partial `WHERE deleted_at IS
 * NULL`, the rollback of the transaction — only exist in the database, so the
 * generated migration is applied as-is and exercised for real.
 */
export async function createTestDatabase() {
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

  return { db, client }
}
