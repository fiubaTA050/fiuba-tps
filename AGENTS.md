<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# FIUBA Classroom

Port of GitHub Classroom — the archived Rails app `github-education-resources/classroom`
(MIT) — to Next.js on Vercel, for cátedra TA050. GitHub Classroom shuts down on
2026-08-28, so this replaces it.

**The original is the design authority.** Before designing anything, read the
corresponding Rails code: it settles questions faster than reasoning from
first principles, and it is what the teachers already expect to use. Clone it
if you do not have it. When this port deviates, the deviation is deliberate and
documented — say so in a comment naming the original file.

## Naming

The original's table and column names are kept so the port reads against the
reference code without mental translation. The confusing one:

- `organizations` is the **classroom**, not the GitHub organization.
- The GitHub org it belongs to is `organizations.github_id`.
- URLs are `/classrooms/...`, matching `resources :organizations, path: "classrooms"`.

## Deliberate divergences from the original

- **GitHub App instead of an OAuth App.** The original persisted every
  teacher's OAuth token in `users.token` and operated on the org with a random
  one. That column does not exist here: privileged calls use an installation
  token, minted on demand and never stored. The user's OAuth token lives only
  in the session JWT.
- **`organizations.installation_id` replaces `organization_webhook_id`.** The
  tenant is the App installation, not an org webhook.
- **Classrooms are named before creation.** The original generated
  `<org>-classroom-1` and let the teacher rename it on a later setup screen.
- **The org list comes from `GET /user/installations`**, so it only shows orgs
  where the App is installed. Orgs without it are reached through "install on
  another organization".
- **The classroom shell follows the live site, not the archived views.** The
  Rails code in this repo predates a redesign: classroom.github.com now tops a
  classroom with a breadcrumb, a title band and a tab bar with counters
  (Assignments · Students · TAs and Admins · Settings), where the archived
  views have a GeoPattern banner and a side menu. The cátedra uses the live one
  every day, so `components/ClassroomShell` and `components/ClassroomNav` copy
  its markup, and `app/globals.css` its `.UnderlineNav` / `.Counter` /
  `.breadcrumb-item` rules. Only two tabs exist here — the other two have
  nothing behind them yet. The shell is composed by each page instead of being
  a layout, because the new-assignment screen and the two assignment dashboards
  wear only the breadcrumb, the same as the live site, and a layout cannot opt
  a route out. **The screens inside the shell are still ported from the Rails
  views**: the live site changed the frame, not the flows, and its roster still
  says "Create roster", "Update students", "Add roster entries".
- **The assignment list inside the shell follows the live site too.** Its rows
  are not a `Box`: each is a full-width `border-top` row with the title, a
  `dot-fill` and Activo/Inactivo, the kind of assignment, a "Copiar link de
  invitación" button and two icon-only buttons. Two divergences: the row also
  says whether the repos are public or private, which the live row leaves out
  and a teacher checks before handing the link out; and the trash links to the
  edit screen's `#borrar` instead of opening a modal, because that is where
  deleting lives here (`docs/edicion-y-borrado-de-assignments.md`), painted red
  at rest where the live one is muted until hover.
- **The assignment dashboard follows the live site too**, for the same reason:
  header band, `StatTiles`, and one `.assignment-repo-list` row per student or
  team with its repository, last commit and commit count. Four things the live
  header carries are not ported and are not coming — Sync assignments (nothing
  propagates to existing repos, see below), autograding, Reuse assignment, and
  the `gh classroom clone` command. The live "Late" label and the per-team
  deadline extension need deadlines, which are not ported either. The commit
  data for the whole cohort comes from one GraphQL query
  (`listRepositorySnapshots`), never one REST call per repository.
- **The invitation link a teacher copies is the short one**, `<host>/a/<key>`
  and `<host>/g/<key>`, ported from the original's ShortKey concern,
  `ShortUrlController` and `routes.rb:31-32`. The long key stays canonical: the
  short route only looks the invitation up and redirects, so links already
  handed out keep working, and an invitation with no short key — every one
  created before this existed — falls back to the long form, exactly as
  `InvitationHelper#invitation_key` does. One divergence: `short_key` is unique
  **in the database**, where the original leaves it to a
  `validates :short_key, uniqueness: true` that races.
- **The dashboard's filters run in the browser**, where the live site puts them
  in the URL — its "Clear current search query, filters, and sorts" is a plain
  link back to the assignment path, because Rails re-renders from the database.
  Here the page is `force-dynamic` and its rows cost a GitHub query, so a filter
  in the URL would re-run that query on every keystroke. Of the live filters,
  "Passing/Failing" (autograding) and the "On-time/Late" halves of the
  submission one (deadlines) have nothing behind them and are dropped.
- **The classroom index is the original's card grid**, `_organization_filters`
  over `_organization_card_layout`, which is still what the live site renders —
  a two-column grid of cards, each with a coloured band, a kebab menu, the
  title over the GitHub org login and up to five assignments. Two divergences.
  The band was a GeoPattern seeded on the classroom id, green when active and
  grey when archived; the live site replaced it with a flat band in those two
  colours and this follows it, so no pattern-generation library is needed. And
  its filters run in the browser for the same reason the dashboard's do: the
  page is `force-dynamic` and every render costs `GET /user/installations` plus
  a call per org, where the original re-rendered from the database
  (`organizations#search`). The kebab is what archives a classroom — every
  writer already refuses to run on an archived one, and this is the only screen
  that sets the flag.
- **"Entregado" is one commit of the student's own**, and the count on the
  dashboard is net of the commit the repository was created with. Neither rule
  is the original's. Its `SharedAssignmentRepoView#submission_succeeded?` is
  `deadline&.passed? && submission_sha.present?` — no deadlines here, so that
  label could never appear; the live site has since moved to a commit-based
  reading ("Submitted: students who've committed to repository") and this
  follows it. Its `AssignmentRepoable#number_of_commits` subtracts the *starter
  code repository's* commit count, which is right only on its importer path:
  this port always calls `POST /repos/.../generate`, and GitHub squashes a
  template into a single "Initial commit" whatever its history — measured, a
  starter of 2 commits gives a student repo of 1, so the original's formula
  would give -1. The baseline is 1 with starter code and 0 without.
- **Group assignments do not use GitHub Teams.** The original gives every group
  a GitHub team and grants the team push access to the repository, which forces
  every student into the organization as a member. Here each member is an
  outside collaborator of the team's repository, the same mechanism the
  individual assignments already use. The original itself explains why its
  design is not worth copying, in `app/models/assignment_repo.rb:45`: it used
  one-person teams for individual assignments too, until "the new organization
  permissions came out […] we were able to move these students over to being an
  outside collaborator" — it migrated that path and left the group one behind.
  Teams also drag along an organization invitation the student has to accept and
  an `admin:org` scope on a student's token
  (`config/initializers/scopes.rb:6`). Consequences, all deliberate:
  - `repo_accesses` + `groups_repo_accesses` collapse into `groups_users`, and
    `groups.github_team_id` does not exist.
  - Access is granted **per member, by that member's own request**: the first
    one to arrive builds the repository, and everyone else picks up their own
    collaborator invitation on the setup screen, so nobody gets an email to
    click. See `docs/creacion-de-repos.md`.
  - Moving a student between teams has to reconcile collaborators by hand
    (`moveMember` in `lib/data/groups.ts`), where the original just moved the
    team membership.
- **The teacher's team screen works.** In the original, `groupings#show`
  advertises drag and drop, but `team-management.js:28` only updates the counter
  in the DOM and never posts; `groups#add_membership` and `#remove_membership`
  exist and nothing calls them, behind a Flipper feature nobody outside GitHub
  had. Without GitHub teams there is no by-hand fix in the org, so this screen
  is the only way to correct a student who joined the wrong team.
- **A team name is unique per classroom**, where the original scopes it to the
  grouping. Several classrooms share one GitHub organization, so this is the
  scope a student can be told about.
- **An assignment slug is unique across the whole GitHub organization**, not
  just the classroom, and across both kinds of assignment. The slug is a
  repository prefix and repository names belong to the org, which hosts one
  classroom per term — see `lib/data/assignment-fields.ts`.
- **Deleting an assignment does not delete the students' repositories.** The
  original's `#destroy` sets `deleted_at` and enqueues `DestroyResourceJob`;
  `assignment_repos` is `dependent: :destroy` and each row carries a
  `before_destroy` that deletes the repository from GitHub
  (`app/models/concerns/assignment_repoable.rb:10`). Its own modal said so —
  "this will also delete N participant repository under the X organization" —
  and the live site still behaves that way. Here it is the soft delete and
  nothing else: for a cátedra the repository *is* the submission and the
  evidence of the grading, and one click taking a hundred of them is a worse
  failure than leaving repositories behind. The partial unique indexes are
  already `where deleted_at is null`, so the title and the prefix are freed by
  that alone, and every read the student reaches inner-joins on the same
  condition, so the invitation link 404s with no extra work.
- **Only allowlisted GitHub organizations can create classrooms.** The
  original had no equivalent and could not: it was GitHub's public service,
  where `Organization::Creator#ensure_users_are_authorized!` and
  `organizations_controller.rb:131` only ever ask "are you an admin of this
  org". This is a single-cátedra deployment on the cátedra's own Supabase, and
  the GitHub App has to stay **public** — a private App only installs on the
  account that owns it, and it lives in a separate account so the org of the
  materia can install it — so without this a stranger installs the App on their
  own org and creates classrooms in our database. `GITHUB_ALLOWED_ORG_IDS`
  holds the org `github_id`s, ids and never logins (DA-2), and it is
  **required**: a deploy that forgets it refuses to create rather than opening
  the door. The boundary is `isAllowedOrganization` inside `createClassroom` —
  the only path that creates one. `/classrooms/new` still lists **every**
  organization the App is installed on and greys out the ones it would refuse,
  with the reason as the tooltip: that is what the original does with the ones
  the teacher is not an owner of (`_disabled_organization_select.html.erb`),
  and a card the teacher can see and understand beats one that is silently
  missing. The allowlist reason wins over "not an owner" when both apply,
  being the one the teacher cannot fix in GitHub.
  The control cannot live on login: students must be able to sign in without
  belonging to any org. Reading is unaffected — the data layer already filters
  by `organizations_users`, and classrooms already created keep working.
  `users.site_admin` exists in the schema, unused, if a master key is ever
  wanted.
- **Editing propagates nothing to the repositories already created**, not even
  the visibility. `Assignment::Editor#update_attribute_for_all_assignment_repos`
  has a single `when "public_repo"` that enqueues
  `AssignmentRepositoryVisibilityJob`; with no queue that would be one GitHub
  call per student inside the teacher's request, against a 60 s function
  ceiling. Every edit screen says so next to the field it applies to.

## Rules

- **No database query outside `lib/data/`.** Every function there takes the
  session and filters by user. There is no RLS; this layer is the authorization
  boundary.
- **GitHub is the source of truth for org and repo metadata.** The database
  stores ids and relationships. Names, avatars, URLs and visibility are read
  from the API at render time. Never key anything on a repo or org name — those
  get renamed, ids do not.
- **Code comments in English. User-facing text in Spanish.**
- When an entity can vanish from GitHub, return `null` and let the UI show it
  as unreachable — the original's `NullGitHubRepository` pattern.
- **The student's repository is created in a request their own browser makes**,
  not in a queue. Before adding a worker, a cron or Inngest, read
  `docs/creacion-de-repos.md`: it records the measurements, GitHub's secondary
  rate limits, why a queue is not needed at this size, and the exact condition
  that would make it needed.
- **Editing and deleting assignments follow
  `docs/edicion-y-borrado-de-assignments.md`**, which records why closing
  submissions belongs in the edit screen and not in a toggle, and what must
  *not* propagate to existing repositories.

## Tests

`npm test` (vitest). Tests run against a real Postgres in-process (PGlite) with
the generated migration applied, so unique indexes and transaction rollbacks are
exercised for real rather than against a mocked query builder.

When porting a feature, port its spec too: the original's `spec/models/` cases
are reusable almost verbatim and encode behaviour that is easy to miss. Cite the
original spec name in a comment.

## Commands

| | |
|---|---|
| `npm run dev` | dev server |
| `npm test` | test suite |
| `npm run build` | production build |
| `npm run db:generate` | generate a migration after editing `db/schema.ts` |
| `npm run db:migrate` | apply migrations |

Credentials live in `.env.local`; `.env.example` lists what is needed and the
README explains how to create the GitHub App.
