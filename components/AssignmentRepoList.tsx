import { GitCommitIcon, MarkGithubIcon, PersonIcon, RepoIcon } from '@primer/octicons-react'

import type { RepositorySnapshot } from '@/lib/github/repositories'

/**
 * The list of repositories on an assignment dashboard, and the one row it is
 * made of. Ported from the live classroom.github.com dashboard —
 * `.assignment-repo-list-item` is its own class, copied into app/globals.css
 * together with `.AvatarStack` and `.Box--condensed`.
 *
 * A row carries, left to right: the avatar, the identifier, a state label, and
 * a meta line with the GitHub handle, the date of the last commit and the
 * commit count; on the right the team's members and a link to the repository.
 *
 * The live site's "Late" label is not here: it compares the last commit against
 * the assignment's deadline, and deadlines are not ported (see db/schema.ts).
 */

export type SubmissionTone = 'success' | 'danger' | 'attention' | 'neutral'

export type SubmissionLabel = {
  text: string
  tone: SubmissionTone
}

const TONE_CLASS: Record<SubmissionTone, string> = {
  success: 'color-bg-success',
  danger: 'color-bg-danger',
  attention: 'color-bg-attention',
  // v22 ships no neutral IssueLabel background; the subtle canvas is what the
  // live site's own grey labels land on
  neutral: 'color-bg-subtle color-fg-muted',
}

/**
 * What a row says about a repository, from the two facts the dashboard has:
 * whether a repository exists, and what GitHub says about it.
 *
 * "Entregado" is one or more commits of the student's own — the baseline the
 * repository was created with is already subtracted in
 * `listRepositorySnapshots`, so a repo still sitting at the starter code reads
 * as "Sin entregar", which is the point.
 *
 * The archived Rails app decided this differently and could not be followed:
 * `SharedAssignmentRepoView#submission_succeeded?` is
 * `deadline&.passed? && submission_sha.present?`, so the label only ever
 * appeared **after a deadline**, and deadlines are not ported. The live site
 * has since moved to the commit-based reading this follows — its own filter
 * says "Submitted: students who've committed to repository".
 *
 * `snapshot` null with an id set is the NullGitHubRepository case — the repo
 * was deleted or moved out of the org. Deleting an assignment here does not
 * delete repositories (DA-9), so the reverse is common too and harmless.
 */
export function submissionLabel(
  hasRepo: boolean,
  snapshot: RepositorySnapshot | null,
): SubmissionLabel {
  if (!hasRepo) return { text: 'Sin repo', tone: 'neutral' }
  if (!snapshot) return { text: 'Repo inaccesible', tone: 'attention' }
  return snapshot.commitCount > 0
    ? { text: 'Entregado', tone: 'success' }
    : { text: 'Sin entregar', tone: 'danger' }
}

export function AssignmentRepoList({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="Box Box--condensed">
      <div className="Box-header">
        <div className="d-table col-12">
          <div className="Box-title col-6 d-table-cell">{title}</div>
        </div>
      </div>

      <div className="Box-body">
        <div className="assignment-repo-list pb-2">{children}</div>
      </div>
    </div>
  )
}

export function RepoListItem({
  avatar,
  name,
  label,
  meta,
  trailing,
  snapshot,
}: {
  /** Null on a team row, which the live site renders with no leading visual */
  avatar: React.ReactNode | null
  name: React.ReactNode
  label: SubmissionLabel
  /** What goes before the commit counters on the meta line: the handle, usually */
  meta?: React.ReactNode
  /** The right-hand column, before the repository link */
  trailing?: React.ReactNode
  snapshot: RepositorySnapshot | null
}) {
  return (
    <div className="d-table col-12 assignment-repo-list-item">
      <div className="col-8 d-table-cell">
        <div className="d-flex width-full">
          {avatar}

          <div className={`flex-column ${avatar ? 'ml-3' : ''}`}>
            <div className="pb-1">
              <span className="h5 mr-2 css-truncate css-truncate-target">{name}</span>
              <span className={`IssueLabel IssueLabel--big mr-2 ${TONE_CLASS[label.tone]}`}>
                {label.text}
              </span>
            </div>

            <div className="d-flex flex-items-baseline flex-wrap">
              {meta}

              {snapshot && (
                <>
                  {/* Only once there is work of their own: with no commits the
                      date is the repository's initial commit, which is the
                      moment it was created and says nothing about a submission */}
                  {snapshot.latestCommitAt && snapshot.commitCount > 0 && (
                    <p className="color-fg-muted mr-3 text-small mb-0">
                      Último commit {formatCommitDate(snapshot.latestCommitAt)}
                    </p>
                  )}

                  <span className="color-fg-muted text-small">
                    <GitCommitIcon className="v-align-bottom mr-1" />
                    {snapshot.commitCount === 1 ? '1 commit' : `${snapshot.commitCount} commits`}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="col-4 d-table-cell v-align-middle">
        <div className="d-flex flex-justify-end flex-items-center">
          {trailing}

          <div className="col-4 text-center">
            {snapshot && (
              <a
                href={snapshot.htmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="Link Link--muted text-small"
                aria-label={`Ver el repositorio ${snapshot.fullName}`}
              >
                <RepoIcon className="v-align-bottom mr-1" />
                Repositorio
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** The avatar of a GitHub account, or the octicon the live site falls back to */
export function AccountAvatar({
  login,
  avatarUrl,
  size = 40,
}: {
  login: string | null
  avatarUrl?: string | null
  size?: number
}) {
  if (!login) {
    return (
      <span className="d-flex flex-items-center color-fg-muted" style={{ width: size }}>
        <MarkGithubIcon size={24} />
      </span>
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={avatarUrl ?? `https://github.com/${login}.png?size=${size * 2}`}
      alt={`@${login}`}
      width={size}
      height={size}
      className="avatar circle flex-shrink-0"
    />
  )
}

/** `_not_in_classroom`: nobody claimed this identifier, so there is no account */
export function NoAccountAvatar({ size = 40 }: { size?: number }) {
  return (
    <span className="d-flex flex-items-center color-fg-muted" style={{ width: size }}>
      <PersonIcon size={24} />
    </span>
  )
}

/** The stacked member avatars of a team, `AvatarStack--right` as on the live site */
export function MemberAvatars({
  members,
}: {
  members: { githubLogin: string | null; githubAvatarUrl: string | null }[]
}) {
  if (members.length === 0) return null

  const named = members.filter((member) => member.githubLogin !== null)
  const label = `${named.map((member) => member.githubLogin).join(', ')} ${
    named.length === 1 ? 'está en este equipo' : 'están en este equipo'
  }`

  // Two avatars, then the fade, then the rest — which `.avatar:nth-child(n+4)`
  // hides until the stack is hovered. Copied from the live markup: the fade is
  // a sibling *between* the avatars, not after them, so it has to be rendered
  // in place rather than appended.
  const shown = members.slice(0, 2)
  const hidden = members.slice(2)

  return (
    <div
      className={`AvatarStack AvatarStack--right mr-3 ${
        members.length > 2
          ? 'AvatarStack--three-plus'
          : members.length === 2
            ? 'AvatarStack--two'
            : ''
      }`}
    >
      <div tabIndex={0} aria-label={label} className="AvatarStack-body">
        {shown.map(memberAvatar)}
        {hidden.length > 0 && <div className="avatar avatar-more" />}
        {hidden.map(memberAvatar)}
      </div>
    </div>
  )
}

function memberAvatar(
  member: { githubLogin: string | null; githubAvatarUrl: string | null },
  index: number,
) {
  return (
    <a
      key={member.githubLogin ?? index}
      href={`https://github.com/${member.githubLogin}`}
      className="avatar avatar-small circle lh-0 Link"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={member.githubAvatarUrl ?? `https://github.com/${member.githubLogin}.png?size=40`}
        alt={`@${member.githubLogin}`}
        width={20}
        height={20}
      />
    </a>
  )
}

/** `May 6, 2026 23:54` on the live site, in the locale the rest of the port uses */
function formatCommitDate(date: Date): string {
  return new Intl.DateTimeFormat('es-AR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}
