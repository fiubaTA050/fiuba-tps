import 'server-only'

/**
 * Postgres unique violation. Drizzle wraps driver errors, and the drivers
 * disagree on the field name — postgres.js uses `constraint_name`, pglite and
 * node-postgres use `constraint` — so walk the cause chain and accept either.
 *
 * Every writer in `lib/data/` checks uniqueness with a query first, for the
 * sake of a specific message, and then races: two teachers can submit the same
 * name at once, and two students can claim the same padrón at once. The unique
 * indexes are the backstop, and losing that race is not an error worth a stack
 * trace.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (let current = error; current; current = (current as { cause?: unknown }).cause) {
    if (typeof current !== 'object') return false
    if ((current as { code?: string }).code === '23505') return true
  }
  return false
}
