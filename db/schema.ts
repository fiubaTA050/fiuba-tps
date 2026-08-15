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

/**
 * The classroom roster: the list of student identifiers the cátedra works
 * with (padrones), and what links each of them to a GitHub account.
 *
 * Defined before `organizations` because that table points at this one, the
 * same direction the original has it (`organizations.roster_id`). Keeping the
 * two tables — instead of hanging the entries off the classroom directly —
 * leaves a roster shareable between classrooms, which is what
 * `RostersController#remove_organization` guards when it only destroys the
 * roster once no organization references it any more.
 *
 * Deliberate divergence: `roster_entries.google_user_id` and `lms_user_id` are
 * not here. They only exist to reconcile a Google Classroom or LTI import
 * against a later sync, and neither integration is ported.
 */
export const rosters = pgTable('rosters', {
  id: serial('id').primaryKey(),
  /** What the identifiers are called, shown as the column header: "Padrón" */
  identifierName: varchar('identifier_name', { length: 255 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const rosterEntries = pgTable(
  'roster_entries',
  {
    id: serial('id').primaryKey(),
    /** The padrón, or whatever the teacher pasted. `validates :identifier, presence: true` */
    identifier: varchar('identifier', { length: 255 }).notNull(),
    rosterId: integer('roster_id')
      .notNull()
      .references(() => rosters.id, { onDelete: 'cascade' }),
    /**
     * The GitHub account behind the identifier, null until it is linked.
     *
     * Nothing writes it yet: in the original the link is made by the student
     * on the `join_roster` screen while accepting an assignment, and that flow
     * is not ported. The column is here because it is what the roster is for,
     * and the UI already reads it.
     */
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('index_roster_entries_on_roster_id').on(table.rosterId),
    index('index_roster_entries_on_user_id').on(table.userId),
    // Divergence: the original had no such index. It deduplicates in Ruby
    // (`add_suffix_to_duplicates`) and checks again before an edit, which two
    // teachers pasting at once can walk straight through. Same reasoning as
    // the assignment indexes: the checks stay for the message, the constraint
    // is the backstop.
    uniqueIndex('index_roster_entries_on_roster_id_and_identifier').on(
      table.rosterId,
      table.identifier,
    ),
  ],
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
    /** The classroom's roster, null until the teacher creates one */
    rosterId: integer('roster_id').references(() => rosters.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('index_organizations_on_github_id').on(table.githubId),
    index('index_organizations_on_deleted_at').on(table.deletedAt),
    index('index_organizations_on_roster_id').on(table.rosterId),
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

/**
 * Individual assignments. Port of `assignments`.
 *
 * Deliberate divergences from the original:
 *
 *  - `template_repos_enabled` is not here. It chose between cloning a template
 *    and the "source importer", and GitHub retired the Source Imports API the
 *    importer called, so only the template path is left and there is nothing
 *    to toggle. `use_template_repos?` is therefore just `starter_code?`.
 *  - Deadlines are not here either: the original's `deadlines` table only
 *    earns its keep together with the Sidekiq job that freezes submissions
 *    when it passes, and there is no job runner on Vercel.
 *  - The uniqueness of `title` and `slug` within a classroom lives in the
 *    database. The original validated them in the model only, over a
 *    `default_scope` that already hid soft-deleted rows; partial indexes
 *    reproduce that exactly and survive two teachers submitting at once.
 */
export const assignments = pgTable(
  'assignments',
  {
    id: serial('id').primaryKey(),
    /** `visibility=` in the original writes this: public_repo = visibility != "private" */
    publicRepo: boolean('public_repo').notNull().default(true),
    title: varchar('title', { length: 255 }).notNull(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    creatorId: integer('creator_id')
      .notNull()
      .references(() => users.id),
    /** Prefixes every student repo: `<slug>-<login>`, see Exercise#default_repo_name */
    slug: varchar('slug', { length: 255 }).notNull(),
    /**
     * Numeric id of the template repository each student repo is generated
     * from. Null means the assignment starts from an empty repo.
     *
     * DA-2: only the id is stored, never the name — the original did the same,
     * and it is what lets the teacher rename the template without breaking
     * anything. bigint rather than the original's int4, like the other ids.
     */
    starterCodeRepoId: bigint('starter_code_repo_id', { mode: 'number' }),
    studentsAreRepoAdmins: boolean('students_are_repo_admins').notNull().default(false),
    invitationsEnabled: boolean('invitations_enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft delete. The original's `default_scope` filters on deleted_at IS NULL */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('index_assignments_on_organization_id').on(table.organizationId),
    index('index_assignments_on_deleted_at').on(table.deletedAt),
    // validates :slug, uniqueness: { scope: :organization_id }
    uniqueIndex('index_assignments_on_organization_id_and_slug')
      .on(table.organizationId, table.slug)
      .where(sql`${table.deletedAt} is null`),
    // validates :title, uniqueness: { scope: :organization_id }
    uniqueIndex('index_assignments_on_organization_id_and_title')
      .on(table.organizationId, table.title)
      .where(sql`${table.deletedAt} is null`),
  ],
)

/**
 * The invitation link a teacher shares. Port of `assignment_invitations`.
 *
 * `short_key` is left out: it only exists to serve the `/a/:short_key` route,
 * which is not ported. `key` is the identifier of the invitation URL, and it
 * is what `AssignmentInvitation#to_param` returns.
 */
export const assignmentInvitations = pgTable(
  'assignment_invitations',
  {
    id: serial('id').primaryKey(),
    /** SecureRandom.hex(16) in the original's `assign_key` */
    key: varchar('key', { length: 255 }).notNull(),
    assignmentId: integer('assignment_id')
      .notNull()
      .references(() => assignments.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('index_assignment_invitations_on_assignment_id').on(table.assignmentId),
    index('index_assignment_invitations_on_deleted_at').on(table.deletedAt),
    uniqueIndex('index_assignment_invitations_on_key').on(table.key),
  ],
)

export type User = typeof users.$inferSelect
export type Organization = typeof organizations.$inferSelect
export type Assignment = typeof assignments.$inferSelect
export type AssignmentInvitation = typeof assignmentInvitations.$inferSelect
export type Roster = typeof rosters.$inferSelect
export type RosterEntry = typeof rosterEntries.$inferSelect
