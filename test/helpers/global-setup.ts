import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import type { TestProject } from 'vitest/node'

/**
 * Builds the migrated database **once** and leaves it on disk as a template
 * every worker restores from.
 *
 * Vitest runs each test file in its own process, so `createTestDatabase` used
 * to run `initdb` fifteen times over — once per file, all at the same time.
 * Measured on this schema: a fresh PGlite plus the eight migrations costs
 * **642 ms**, of which the migrations are only 53 ms; the rest is `initdb`.
 * Restoring a dump of that same database costs **130 ms**.
 *
 * So the fifteen `initdb` runs become one, and each worker pays a tarball
 * extraction instead. That is the resource cost worth attacking: the wall
 * clock was never terrible, but fifteen WebAssembly Postgres instances all
 * initialising at once is what pinned every core.
 *
 * The dump is uncompressed on purpose — `'none'` is ~40 MB and loads fastest,
 * and it lives in a temp directory removed when the run ends.
 */
export default async function setup(project: TestProject) {
  const client = new PGlite()

  // The generated migrations, applied as-is: the behaviours the suite cares
  // about — the unique indexes, the partial `WHERE deleted_at IS NULL`, the
  // rollback of a transaction — only exist in the database.
  const directoryOfMigrations = join(process.cwd(), 'db/migrations')
  const files = readdirSync(directoryOfMigrations)
    .filter((file) => file.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const sql = readFileSync(join(directoryOfMigrations, file), 'utf8')
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) await client.exec(statement)
    }
  }

  const dump = await client.dumpDataDir('none')
  await client.close()

  const directory = mkdtempSync(join(tmpdir(), 'fiuba-tps-pglite-'))
  const path = join(directory, 'template.tar')
  writeFileSync(path, Buffer.from(await dump.arrayBuffer()))

  project.provide('pgliteTemplate', path)

  return () => {
    rmSync(directory, { recursive: true, force: true })
  }
}

declare module 'vitest' {
  interface ProvidedContext {
    /** Where the migrated template database was dumped */
    pgliteTemplate: string
  }
}
