import { desc, sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
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
 *  - There is no deadline column. The original's `deadlines` table hangs one
 *    date off the assignment; here a date belongs to a `checkpoint`, because
 *    one assignment can have several entregas with a date each (TP2 is 2A to
 *    2D over the same repository). See docs/entregas.md.
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
    /**
     * The eight characters behind `/a/<short_key>`, from the original's
     * ShortKey concern. Nullable: rows created before it existed keep only the
     * long key, and the link falls back to it, exactly as
     * `InvitationHelper#invitation_key` does.
     */
    shortKey: varchar('short_key', { length: 255 }),
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
    // The original indexes this without a unique constraint and leaves the
    // uniqueness to `validates :short_key, uniqueness: true`, which is a
    // read-then-write and races. Unique here, where it cannot: Postgres allows
    // any number of NULLs, so the `allow_nil` half still holds.
    uniqueIndex('index_assignment_invitations_on_short_key').on(table.shortKey),
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
 *  - `submission_sha`, which its `DeadlineJob` froze with whatever HEAD the
 *    worker found when it woke up. Here a submission is a row of its own in
 *    `submissions`, append-only and written by the student — nothing freezes
 *    anything on a timer. See docs/entregas.md.
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

/**
 * A reusable set of teams. Port of `groupings`.
 *
 * The teams of a classroom belong to a set, not to an assignment, which is what
 * lets the second group assignment of the term run on the teams formed for the
 * first one — the `select` of `_group_assignment_form_options.html.erb`.
 */
export const groupings = pgTable(
  'groupings',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('index_groupings_on_organization_id').on(table.organizationId),
    // validates :title, uniqueness: { scope: :organization }
    uniqueIndex('index_groupings_on_organization_id_and_title').on(
      table.organizationId,
      table.title,
    ),
    // validates :slug, uniqueness: { scope: :organization }
    uniqueIndex('index_groupings_on_organization_id_and_slug').on(table.organizationId, table.slug),
    // What the composite foreign key in `groups` points at, so that a group's
    // denormalised `organization_id` cannot disagree with its grouping's.
    unique('groupings_id_organization_id_key').on(table.id, table.organizationId),
  ],
)

/**
 * One team. Port of `groups`.
 *
 * Deliberate divergences from the original:
 *
 *  - `github_team_id` is not here. The original backs every group with a GitHub
 *    team and gives the team push access to the repository; this port makes
 *    each member an outside collaborator instead, the same mechanism the
 *    individual assignments already use. The original itself explains why its
 *    own design is not worth copying, in `app/models/assignment_repo.rb:45`:
 *    it used one-person teams for individual assignments too, until "the new
 *    organization permissions came out […] we were able to move these students
 *    over to being an outside collaborator". It migrated the individual path
 *    and left the group one behind. Teams also drag along organization
 *    membership, an invitation the student has to accept, and an `admin:org`
 *    scope on a student's token (`config/initializers/scopes.rb:6`).
 *  - The name is unique per **classroom**, where the original scopes it to the
 *    grouping. Several classrooms share one GitHub organization, so this is the
 *    scope a student can actually be told about: "ese nombre ya está usado en
 *    este classroom".
 */
export const groups = pgTable(
  'groups',
  {
    id: serial('id').primaryKey(),
    groupingId: integer('grouping_id').notNull(),
    /**
     * Denormalised from the grouping, so that "unique within the classroom" is
     * an index instead of a query. The composite foreign key below is what
     * keeps it honest.
     */
    organizationId: integer('organization_id').notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    /** `title.parameterize` (Sluggable). Ends up in the repo name */
    slug: varchar('slug', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('index_groups_on_grouping_id').on(table.groupingId),
    foreignKey({
      columns: [table.groupingId, table.organizationId],
      foreignColumns: [groupings.id, groupings.organizationId],
      name: 'groups_grouping_id_organization_id_fkey',
    }).onDelete('cascade'),
    uniqueIndex('index_groups_on_organization_id_and_slug').on(table.organizationId, table.slug),
    // What the composite foreign key in `groups_users` points at
    unique('groups_id_grouping_id_key').on(table.id, table.groupingId),
  ],
)

/**
 * Who is on which team. Replaces the original's `repo_accesses` +
 * `groups_repo_accesses` pair.
 *
 * `repo_accesses` is a (user, organization) row whose whole job is to record
 * that the student was added to the GitHub organization and to carry the
 * one-person team of the legacy individual flow. With no organization
 * membership and no teams there is nothing left for it to hold, so the
 * many-to-many collapses straight onto `users`.
 */
export const groupsUsers = pgTable(
  'groups_users',
  {
    groupId: integer('group_id').notNull(),
    /** Denormalised from the group, for the uniqueness below */
    groupingId: integer('grouping_id').notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.userId] }),
    index('index_groups_users_on_user_id').on(table.userId),
    foreignKey({
      columns: [table.groupId, table.groupingId],
      foreignColumns: [groups.id, groups.groupingId],
      name: 'groups_users_group_id_grouping_id_fkey',
    }).onDelete('cascade'),
    // A student belongs to exactly one team of a given set. The original only
    // ever asks the question — `Group.joins(:repo_accesses).find_by(grouping:,
    // repo_accesses: { id: })` in GroupAssignmentInvitation#group — and nothing
    // stops two rows from existing, so two tabs on the team picker put a
    // student on two teams and give them two repositories.
    uniqueIndex('index_groups_users_on_grouping_id_and_user_id').on(
      table.groupingId,
      table.userId,
    ),
  ],
)

/**
 * Group assignments. Port of `group_assignments`, and the mirror of
 * `assignments` above — same columns, same divergences (no
 * `template_repos_enabled`, no deadlines), plus the set of teams and the two
 * limits.
 *
 * A separate table rather than a flag on `assignments`, as in the original: it
 * keeps `assignment_repos.user_id` and `group_assignment_repos.group_id` both
 * NOT NULL and their unique indexes meaningful. The sharing happens in the
 * TypeScript, which is where the original shares it too
 * (`CreateGitHubRepoService::Exercise` and its two subclasses).
 *
 * The uniqueness that is *not* here: the original's
 * `validate :uniqueness_of_slug_across_organization` also refuses a slug that
 * an individual `Assignment` of the same classroom already holds, and this port
 * widens that to every classroom sharing the same `organizations.github_id` —
 * `<slug>-<team>` is a repository name, repository names are unique per GitHub
 * organization, and one organization hosts every year's classroom. Neither
 * check can be an index (they span tables and rows), so both live in
 * lib/data/group-assignments.ts.
 */
export const groupAssignments = pgTable(
  'group_assignments',
  {
    id: serial('id').primaryKey(),
    publicRepo: boolean('public_repo').notNull().default(true),
    title: varchar('title', { length: 255 }).notNull(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** The set of teams this assignment runs on. `belongs_to :grouping` */
    groupingId: integer('grouping_id')
      .notNull()
      .references(() => groupings.id),
    creatorId: integer('creator_id')
      .notNull()
      .references(() => users.id),
    /** Prefixes every team repo: `<slug>-<team-slug>` */
    slug: varchar('slug', { length: 255 }).notNull(),
    starterCodeRepoId: bigint('starter_code_repo_id', { mode: 'number' }),
    /** Null means no limit, as in the original */
    maxMembers: integer('max_members'),
    maxTeams: integer('max_teams'),
    studentsAreRepoAdmins: boolean('students_are_repo_admins').notNull().default(false),
    invitationsEnabled: boolean('invitations_enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('index_group_assignments_on_organization_id').on(table.organizationId),
    index('index_group_assignments_on_grouping_id').on(table.groupingId),
    index('index_group_assignments_on_deleted_at').on(table.deletedAt),
    uniqueIndex('index_group_assignments_on_organization_id_and_slug')
      .on(table.organizationId, table.slug)
      .where(sql`${table.deletedAt} is null`),
    uniqueIndex('index_group_assignments_on_organization_id_and_title')
      .on(table.organizationId, table.title)
      .where(sql`${table.deletedAt} is null`),
  ],
)

/** The invitation link of a group assignment. Port of `group_assignment_invitations` */
export const groupAssignmentInvitations = pgTable(
  'group_assignment_invitations',
  {
    id: serial('id').primaryKey(),
    key: varchar('key', { length: 255 }).notNull(),
    /** The eight characters behind `/g/<short_key>`, as on the individual one */
    shortKey: varchar('short_key', { length: 255 }),
    groupAssignmentId: integer('group_assignment_id')
      .notNull()
      .references(() => groupAssignments.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('index_group_assignment_invitations_on_group_assignment_id').on(table.groupAssignmentId),
    index('index_group_assignment_invitations_on_deleted_at').on(table.deletedAt),
    uniqueIndex('index_group_assignment_invitations_on_key').on(table.key),
    uniqueIndex('index_group_assignment_invitations_on_short_key').on(table.shortKey),
  ],
)

/**
 * One team's repository for one group assignment. Port of
 * `group_assignment_repos`.
 *
 * The same shape as `assignment_repos`, with the team where the student is: the
 * row exists only once the GitHub repository does, and everything before that
 * lives in `group_invite_statuses`.
 */
export const groupAssignmentRepos = pgTable(
  'group_assignment_repos',
  {
    id: serial('id').primaryKey(),
    githubRepoId: bigint('github_repo_id', { mode: 'number' }).notNull(),
    groupAssignmentId: integer('group_assignment_id')
      .notNull()
      .references(() => groupAssignments.id, { onDelete: 'cascade' }),
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('index_group_assignment_repos_on_group_assignment_id').on(table.groupAssignmentId),
    index('index_group_assignment_repos_on_group_id').on(table.groupId),
    uniqueIndex('index_group_assignment_repos_on_github_repo_id').on(table.githubRepoId),
    // `validates :group, uniqueness: { scope: :group_assignment }`. In the
    // database here: the whole team is racing the same button, and two members
    // getting through at once would build the team two repositories.
    uniqueIndex('index_group_assignment_repos_on_assignment_id_and_group_id').on(
      table.groupAssignmentId,
      table.groupId,
    ),
  ],
)

/**
 * One row per (invitation, team). Port of `group_invite_statuses`.
 *
 * Keyed on the team, not on the student: the repository belongs to the team, so
 * whoever accepts first drives it to `completed` and the rest of the team joins
 * a repository that is already there. Reuses the `invite_status` enum, which is
 * the same lifecycle.
 */
export const groupInviteStatuses = pgTable(
  'group_invite_statuses',
  {
    id: serial('id').primaryKey(),
    status: inviteStatusEnum('status').notNull().default('unaccepted'),
    groupAssignmentInvitationId: integer('group_assignment_invitation_id')
      .notNull()
      .references(() => groupAssignmentInvitations.id, { onDelete: 'cascade' }),
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('index_group_invite_statuses_on_group_id').on(table.groupId),
    // validates :group_id, uniqueness: { scope: :group_assignment_invitation_id,
    // message: "should only have 1 invitation per group" }
    uniqueIndex('index_group_invite_statuses_on_invitation_id_and_group_id').on(
      table.groupAssignmentInvitationId,
      table.groupId,
    ),
  ],
)

/**
 * One entrega of an assignment: what a student hands in against.
 *
 * There is no equivalent in the original, whose `deadlines` table hangs a
 * single date off the assignment. The case that forced this shape is TP2:
 * four entregas — 2A, 2B, 2C, 2D — with a date each, over the same repository.
 * An assignment with one date is not a special case, it is one checkpoint.
 *
 * **A checkpoint is the entrega, not an optional part of one**: an assignment
 * with no checkpoints has nothing to hand in, which is a legal state meaning
 * the teacher has not opened submissions yet. Nothing creates one implicitly,
 * and no migration backfilled the assignments that already existed.
 *
 * `deadline_at` is nullable — an entrega whose date is not decided yet — which
 * is why the order comes from `position` and not from the date. See
 * docs/entregas.md.
 */
export const checkpoints = pgTable(
  'checkpoints',
  {
    id: serial('id').primaryKey(),
    assignmentId: integer('assignment_id')
      .notNull()
      .references(() => assignments.id, { onDelete: 'cascade' }),
    /** "2A". Null is the single unnamed entrega of an assignment with no parts */
    title: varchar('title', { length: 60 }),
    /** Decides late/on-time. It closes nothing — see docs/entregas.md */
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('index_checkpoints_on_assignment_id').on(table.assignmentId),
    uniqueIndex('index_checkpoints_on_assignment_id_and_title').on(table.assignmentId, table.title),
    // Two NULLs do not collide in a unique index, so the unnamed entrega needs
    // its own partial one — the shape of index_roster_entries_on_roster_id_and_user_id
    uniqueIndex('index_checkpoints_on_assignment_id_unnamed')
      .on(table.assignmentId)
      .where(sql`${table.title} is null`),
  ],
)

/**
 * One confirmed submission: the student picked a ref of their repository and
 * confirmed, which froze a SHA.
 *
 * **Append-only.** Re-submitting inserts another row, never an UPDATE, so
 * there is no unique index over (repo, checkpoint): the current submission is
 * the last row, and the serial `id` breaks the tie rather than `submitted_at`.
 * The reason is not the audit trail — it is that with a deadline per entrega a
 * late re-submission would overwrite the one that was on time. What the unique
 * index would have covered, the double click, is covered by refusing to insert
 * a SHA equal to the last one.
 *
 * `committed_at` is denormalised on purpose: reading it from GitHub would cost
 * one call per repository on the teacher's dashboard, which is what
 * `listRepositorySnapshots` exists to avoid. It comes free in the response that
 * resolved the ref.
 *
 * See docs/entregas.md for why the student declares the SHA instead of a job
 * freezing it, and for the fork-network hole in resolving a ref.
 */
export const submissions = pgTable(
  'submissions',
  {
    id: serial('id').primaryKey(),
    assignmentRepoId: integer('assignment_repo_id')
      .notNull()
      .references(() => assignmentRepos.id, { onDelete: 'cascade' }),
    // No cascade, unlike the rest: deleting a checkpoint that has submissions
    // would destroy the evidence of the grading, the same stance as DA-9 on
    // deleting an assignment. lib/data/checkpoints.ts refuses it instead.
    checkpointId: integer('checkpoint_id')
      .notNull()
      .references(() => checkpoints.id),
    /** The resolved ref. This is what the teacher grades */
    sha: varchar('sha', { length: 40 }).notNull(),
    /** What the student typed — `main`, a tag, a sha. Evidence of intent */
    ref: varchar('ref', { length: 255 }).notNull(),
    // Nullable, not because it is optional going forward — the form requires
    // it — but because submissions confirmed before this column existed can't
    // be backfilled with an answer nobody gave. Same stance as checkpoints:
    // no retroactive data for a fact that didn't exist yet.
    /** Declaración jurada: qué herramientas de IA usó el alumno y para qué, o que no usó ninguna */
    aiDeclaration: text('ai_declaration'),
    committedAt: timestamp('committed_at', { withTimezone: true }).notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    // NOT NULL: with nothing freezing submissions on a timer, the only writer
    // is the student. On a team repository this is *the* interesting column
    submittedByUserId: integer('submitted_by_user_id')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    // Serves the `distinct on (assignment_repo_id, checkpoint_id) … order by
    // id desc` that reads the current submission of every repository at once
    index('index_submissions_on_repo_and_checkpoint').on(
      table.assignmentRepoId,
      table.checkpointId,
      desc(table.id),
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
export type Grouping = typeof groupings.$inferSelect
export type Group = typeof groups.$inferSelect
export type GroupAssignment = typeof groupAssignments.$inferSelect
export type GroupAssignmentInvitation = typeof groupAssignmentInvitations.$inferSelect
export type GroupAssignmentRepo = typeof groupAssignmentRepos.$inferSelect
export type GroupInviteStatus = typeof groupInviteStatuses.$inferSelect
export type Checkpoint = typeof checkpoints.$inferSelect
export type Submission = typeof submissions.$inferSelect
