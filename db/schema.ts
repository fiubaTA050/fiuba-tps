import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'

/**
 * Port of `db/schema.rb` from github-education-resources/classroom.
 *
 * The original's table and column names are kept (`organizations` is the
 * classroom, not the GitHub org) so the rest of the port reads against the
 * reference code without mental translation.
 *
 * Deliberate divergences from the original, see spec §4:
 *
 *  - `users.token` does not exist. The original persisted every teacher's
 *    OAuth token and used a random org user's as the API client
 *    (`Organization#github_client`). DA-6 forbids that: privileged operations
 *    go through the GitHub App's installation token.
 *  - `organizations.organization_webhook_id` is replaced by
 *    `installation_id`. The original registered an organization webhook; here
 *    the tenant is the App installation (DA-3).
 *  - The `github_id`s are bigint instead of integer. The original stayed on
 *    int4; GitHub's IDs are getting close to the limit.
 */

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    /** The user's numeric GitHub ID */
    uid: bigint('uid', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    siteAdmin: boolean('site_admin').notNull().default(false),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    githubLogin: varchar('github_login', { length: 255 }),
    githubName: varchar('github_name', { length: 255 }),
    githubAvatarUrl: varchar('github_avatar_url', { length: 255 }),
    githubHtmlUrl: varchar('github_html_url', { length: 255 }),
    teacher: boolean('teacher'),
    student: boolean('student'),
  },
  (table) => [uniqueIndex('index_users_on_uid').on(table.uid)],
)

export const organizations = pgTable(
  'organizations',
  {
    id: serial('id').primaryKey(),
    /** Numeric ID of the GitHub organization backing the classroom */
    githubId: bigint('github_id', { mode: 'number' }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 255 }).notNull(),
    /** The GitHub App installation on that org. This is the tenant identifier */
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft delete. The original's `default_scope` filters on deleted_at IS NULL */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    index('index_organizations_on_github_id').on(table.githubId),
    index('index_organizations_on_deleted_at').on(table.deletedAt),
    // Partial, so a soft-deleted classroom stops reserving its title and slug.
    // Rails enforced these in the model, where default_scope already excluded
    // deleted rows; a plain unique index would outlive the delete and make the
    // name unrecoverable.
    uniqueIndex('index_organizations_on_slug')
      .on(table.slug)
      .where(sql`${table.deletedAt} is null`),
    // validates :title, uniqueness: { scope: :github_id }
    uniqueIndex('index_organizations_on_github_id_and_title')
      .on(table.githubId, table.title)
      .where(sql`${table.deletedAt} is null`),
  ],
)

/** has_and_belongs_to_many :users — the classroom's teachers */
export const organizationsUsers = pgTable(
  'organizations_users',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.organizationId] })],
)

export type User = typeof users.$inferSelect
export type Organization = typeof organizations.$inferSelect
