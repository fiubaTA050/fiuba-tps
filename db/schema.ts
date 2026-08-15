import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
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
     * Written by the student on the `join_roster` screen while accepting an
     * assignment — `InvitationsControllerMethods#join_roster` — never by the
     * teacher.
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
    // Divergence: the original has no such index, and it needs one.
    // `InvitationsControllerMethods#join_roster` reads
    //
    //   entry.update_attributes!(user: current_user) unless user_on_roster?
    //
    // where `user_on_roster?` asks whether *the student* already claimed an
    // entry — never whether *the entry* is already claimed. So a student who
    // picks a padrón that belongs to somebody else takes it over, and the
    // rightful owner is silently unlinked. lib/data/invitations.ts refuses that
    // case with a message; this is the backstop for two students picking the
    // same padrón at once. Partial, because unlinked entries are the norm.
    uniqueIndex('index_roster_entries_on_roster_id_and_user_id')
      .on(table.rosterId, table.userId)
      .where(sql`${table.userId} is not null`),
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

/**
 * One student's repository for one assignment. Port of `assignment_repos`.
 *
 * A row exists only once the GitHub repository does — `github_repo_id` is NOT
 * NULL, same as the original. The state before that lives in
 * `invite_statuses`, which is the split db/schema.ts documents below.
 *
 * Three of the original's columns are not here:
 *
 *  - `repo_access_id`, which pointed at the one-person GitHub team the original
 *    used before organization permissions let it make students outside
 *    collaborators. Its own model calls the pairing legacy.
 *  - `submission_sha`, written only when a deadline freezes a submission, and
 *    deadlines are not ported.
 *  - `configuration_state`, which the original itself marks
 *    `# TODO: remove this enum (dead code)`.
 */
export const assignmentRepos = pgTable(
  'assignment_repos',
  {
    id: serial('id').primaryKey(),
    /** Numeric id of the repo on GitHub. DA-2: the name is never stored */
    githubRepoId: bigint('github_repo_id', { mode: 'number' }).notNull(),
    assignmentId: integer('assignment_id')
      .notNull()
      .references(() => assignments.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('index_assignment_repos_on_assignment_id').on(table.assignmentId),
    index('index_assignment_repos_on_user_id').on(table.userId),
    uniqueIndex('index_assignment_repos_on_github_repo_id').on(table.githubRepoId),
    // `validate :assignment_user_key_uniqueness` — "Should only have one
    // assignment repository for each user-assignment combination". In the
    // database rather than only in the model: two tabs racing the create-repo
    // route would otherwise leave the student with two repositories and the
    // classroom paying for one nobody opens.
    uniqueIndex('index_assignment_repos_on_assignment_id_and_user_id').on(
      table.assignmentId,
      table.userId,
    ),
  ],
)

/**
 * Port of the SetupStatus concern's enum, in the original's order.
 *
 * This is the whole lifecycle of one student's invitation, and it is where the
 * state "accepted, but there is no repository yet" already lives in the
 * original — not in `assignment_repos`, whose rows only ever exist alongside a
 * real GitHub repo (`github_repo_id` is NOT NULL there). It is also the queue
 * the original's own background job reads: `create_repo` enqueues exactly when
 * the status is `accepted` or one of the `errored_*`.
 *
 * Every value is defined even though this port can only reach `unaccepted` and
 * `accepted`: repository creation is not ported yet, and the job that will do
 * it should find its states already here instead of needing a migration.
 */
export const INVITE_STATUSES = [
  'unaccepted',
  'accepted',
  'waiting',
  'creating_repo',
  'importing_starter_code',
  'completed',
  'errored_creating_repo',
  'errored_importing_starter_code',
] as const

export type InviteStatusValue = (typeof INVITE_STATUSES)[number]

/** SetupStatus::SETUP_STATUSES — accepted, and on the way to a repository */
export const SETUP_STATUSES: readonly InviteStatusValue[] = [
  'accepted',
  'waiting',
  'creating_repo',
  'importing_starter_code',
]

/** SetupStatus::ERRORED_STATUSES */
export const ERRORED_STATUSES: readonly InviteStatusValue[] = [
  'errored_creating_repo',
  'errored_importing_starter_code',
]

export const inviteStatusEnum = pgEnum('invite_status', INVITE_STATUSES)

/**
 * One row per (invitation, student). Port of `invite_statuses`.
 *
 * Divergence: the original stored the enum as an integer, because that is what
 * Rails' `enum` does. Here it is a Postgres enum with the original's labels —
 * the same states in the same order, readable in a psql session, and the one
 * place a typo would otherwise pass silently.
 *
 * The original creates the row lazily from `AssignmentInvitation#status`, so
 * merely opening the link writes an `unaccepted` row. Here the row appears only
 * when the student accepts: a Server Component renders on prefetch and on every
 * revalidation, and a GET that writes would fill the table with rows for people
 * who only clicked the link. `unaccepted` is therefore what the absence of a
 * row means, which is what `findInvitation` returns.
 */
export const inviteStatuses = pgTable(
  'invite_statuses',
  {
    id: serial('id').primaryKey(),
    status: inviteStatusEnum('status').notNull().default('unaccepted'),
    assignmentInvitationId: integer('assignment_invitation_id')
      .notNull()
      .references(() => assignmentInvitations.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('index_invite_statuses_on_user_id').on(table.userId),
    // validates :user_id, uniqueness: { scope: :assignment_invitation_id }.
    // In the database rather than only in the model: accepting twice is one
    // impatient double-click away.
    uniqueIndex('index_invite_statuses_on_invitation_id_and_user_id').on(
      table.assignmentInvitationId,
      table.userId,
    ),
  ],
)

export type User = typeof users.$inferSelect
export type Organization = typeof organizations.$inferSelect
export type Assignment = typeof assignments.$inferSelect
export type AssignmentInvitation = typeof assignmentInvitations.$inferSelect
export type Roster = typeof rosters.$inferSelect
export type RosterEntry = typeof rosterEntries.$inferSelect
export type InviteStatus = typeof inviteStatuses.$inferSelect
export type AssignmentRepo = typeof assignmentRepos.$inferSelect
