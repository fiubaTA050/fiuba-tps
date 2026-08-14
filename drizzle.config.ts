import { loadEnvConfig } from '@next/env'
import type { Config } from 'drizzle-kit'

// drizzle-kit only reads `.env`, while Next uses `.env.local`. Loading it with
// Next's own loader keeps both reading the same file, in the same precedence.
loadEnvConfig(process.cwd())

export default {
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // Migrations want the session pooler (port 5432), not the transaction one:
    // DDL and advisory locks need a session that survives between statements.
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL!,
  },
} satisfies Config
