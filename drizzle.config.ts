import type { Config } from 'drizzle-kit'

export default {
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // Migrations want the direct connection (port 5432), not the pooler
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL!,
  },
} satisfies Config
