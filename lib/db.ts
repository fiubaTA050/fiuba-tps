import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from '@/db/schema'
import { env } from '@/lib/env'

type Database = PostgresJsDatabase<typeof schema>

let instance: Database | undefined

function connect(): Database {
  if (instance) return instance

  // Supabase pooler (port 6543). `prepare: false` is required: prepared
  // statements do not survive between requests in transaction pooling mode.
  instance = drizzle(postgres(env.databaseUrl, { prepare: false }), { schema })
  return instance
}

/**
 * The connection opens on first use, not when the module is imported:
 * `next build` evaluates these modules to collect the pages, and at that point
 * there is no DATABASE_URL yet.
 */
export const db = new Proxy({} as Database, {
  get: (_target, property, receiver) => Reflect.get(connect(), property, receiver),
})
