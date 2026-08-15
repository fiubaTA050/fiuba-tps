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
  a layout, because the new-assignment screen wears only the breadcrumb, the
  same as the live site, and a layout cannot opt one route out. **The screens
  inside the shell are still ported from the Rails views**: the live site
  changed the frame, not the flows, and its roster still says "Create roster",
  "Update students", "Add roster entries".
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
- **Editing and deleting assignments are not built yet, and the design is
  already settled**: read `docs/edicion-y-borrado-de-assignments.md` first. It
  records why closing submissions belongs in the edit screen and not in a
  toggle, that no migration is needed, what must *not* propagate to existing
  repositories, and the open decision about whether deleting an assignment
  should delete the students' repositories the way the original does.

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
