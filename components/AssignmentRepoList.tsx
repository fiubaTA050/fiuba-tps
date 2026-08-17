'use client'

import {
  CheckIcon,
  GitCommitIcon,
  MarkGithubIcon,
  PersonIcon,
  RepoIcon,
  SearchIcon,
  TriangleDownIcon,
  XCircleFillIcon,
  XIcon,
} from '@primer/octicons-react'
import { useMemo, useState } from 'react'

import { hasSubmitted, type RepoRow, type SubmissionTone } from '@/lib/assignment-rows'

/**
 * The list of repositories on an assignment dashboard, with the filter bar the
 * live classroom.github.com puts above it. Ported from a saved copy of that
 * page — `.assignment-repo-list-item` is its own class, copied into
 * app/globals.css together with `.AvatarStack` and `.Box--condensed`.
 *
 * A row carries, left to right: the avatar, the identifier, a state label, and
 * a meta line with the GitHub handle, the date of the last commit and the
 * commit count; on the right the team's members and a link to the repository.
 *
 * **Filtering is client-side, where the live site does it in the URL.** Its
 * "Clear current search query, filters, and sorts" is a plain link back to the
 * assignment path, because Rails re-renders the page from the database. Here
 * the page is `force-dynamic` and its rows cost a GitHub query, so putting the
 * filters in the URL would re-run that query on every keystroke. The whole
 * cohort is already in the browser; filtering it there is instant and free.
 *
 * Two of the live filters have nothing behind them: "Passing/Failing" is
 * autograding, and the "On-time/Late" halves of the submission filter need
 * deadlines. Neither is ported.
 */

/** The live "Filter by submission", minus its two deadline options */
type SubmissionFilter = 'submitted' | 'not_submitted'
/** The live "Filter by accepted" */
type AcceptedFilter = 'accepted' | 'unaccepted'
/** The live "Filter by unlinked" */
type UnlinkedFilter = 'identifiers' | 'accounts'
/** The live "Sort by" */
type Sort = 'az' | 'za' | 'newest' | 'oldest'

const SORT_LABEL: Record<Sort, string> = {
  az: 'Alfabético A-Z',
  za: 'Alfabético Z-A',
  newest: 'Más reciente',
  oldest: 'Más antiguo',
}

const TONE_CLASS: Record<SubmissionTone, string> = {
  success: 'color-bg-success',
  danger: 'color-bg-danger',
  attention: 'color-bg-attention',
  // v22 ships no neutral IssueLabel background; the subtle canvas is what the
  // live site's own grey labels land on
  neutral: 'color-bg-subtle color-fg-muted',
}

export function AssignmentRepoList({ title, rows }: { title: string; rows: RepoRow[] }) {
  const [query, setQuery] = useState('')
  const [submission, setSubmission] = useState<Set<SubmissionFilter>>(new Set())
  const [accepted, setAccepted] = useState<Set<AcceptedFilter>>(new Set())
  const [unlinked, setUnlinked] = useState<Set<UnlinkedFilter>>(new Set())
  const [sort, setSort] = useState<Sort>('az')

  const filtered = useMemo(() => {
    // "the student's GitHub handle, their identifier, or the team's name"
    const needle = query.trim().toLowerCase()

    const kept = rows.filter((row) => {
      if (
        needle &&
        !row.name.toLowerCase().includes(needle) &&
        !(row.githubLogin ?? '').toLowerCase().includes(needle)
      ) {
        return false
      }

      // Each group is a set of checkboxes: empty means "no opinion", and two
      // boxes of the same group are an OR, the way the live menus behave
      if (submission.size > 0) {
        const state: SubmissionFilter = hasSubmitted(row) ? 'submitted' : 'not_submitted'
        if (!submission.has(state)) return false
      }

      if (accepted.size > 0) {
        const state: AcceptedFilter = row.accepted ? 'accepted' : 'unaccepted'
        if (!accepted.has(state)) return false
      }

      if (unlinked.size > 0) {
        const matches =
          (unlinked.has('identifiers') && row.unlinkedIdentifier) ||
          (unlinked.has('accounts') && row.unlinkedAccount)
        if (!matches) return false
      }

      return true
    })

    return [...kept].sort(compareBy(sort))
  }, [rows, query, submission, accepted, unlinked, sort])

  const dirty =
    query !== '' || submission.size > 0 || accepted.size > 0 || unlinked.size > 0 || sort !== 'az'

  function clear() {
    setQuery('')
    setSubmission(new Set())
    setAccepted(new Set())
    setUnlinked(new Set())
    setSort('az')
  }

  return (
    <>
      <h2 className="sr-only">Filtrar el listado</h2>

      {/* The live bar: "Filters" and the search field joined in a BtnGroup on
          the left, the rest of the menus on the right, stacking on narrow
          screens with the search field on top */}
      <div className="position-relative d-flex flex-column-reverse flex-lg-row flex-wrap flex-lg-nowrap">
        <div className="d-flex flex-1 BtnGroup">
          <CheckboxMenu
            label="Filtros"
            heading="Filtrar por entrega:"
            grouped
            options={[
              { value: 'submitted', label: 'Entregado', description: 'Tienen commits propios' },
              {
                value: 'not_submitted',
                label: 'Sin entregar',
                description: 'Todavía no subieron nada',
              },
            ]}
            selected={submission}
            onToggle={(value) => setSubmission(toggle(submission, value))}
          />

          <div className="width-full mr-2">
            <div className="FormControl-input-wrap FormControl-input-wrap--leadingVisual FormControl-input-wrap--trailingAction">
              <span className="FormControl-input-leadingVisualWrap">
                <SearchIcon className="FormControl-input-leadingVisual" />
              </span>

              <input
                type="text"
                className="form-control width-full"
                placeholder="Buscar en el listado"
                aria-label="Buscar por identificador, cuenta de GitHub o equipo"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />

              {query !== '' && (
                <button
                  type="button"
                  className="FormControl-input-trailingAction"
                  aria-label="Limpiar la búsqueda"
                  onClick={() => setQuery('')}
                >
                  <XCircleFillIcon />
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="d-flex flex-wrap mb-2 mb-lg-0">
          <CheckboxMenu
            label="Filtrar por cuentas sin vincular"
            heading="Filtrar por vínculo:"
            options={[
              {
                value: 'identifiers',
                label: 'Identificadores',
                description: 'Nadie reclamó ese identificador',
              },
              {
                value: 'accounts',
                label: 'Cuentas de GitHub',
                description: 'Aceptaron sin elegir su identificador',
              },
            ]}
            selected={unlinked}
            onToggle={(value) => setUnlinked(toggle(unlinked, value))}
          />

          <CheckboxMenu
            label="Filtrar por aceptación"
            heading="Filtrar por aceptación:"
            options={[
              { value: 'accepted', label: 'Aceptaron', description: 'Aceptaron el assignment' },
              {
                value: 'unaccepted',
                label: 'No aceptaron',
                description: 'Todavía no lo aceptaron',
              },
            ]}
            selected={accepted}
            onToggle={(value) => setAccepted(toggle(accepted, value))}
          />

          <details className="dropdown details-reset details-overlay d-inline-block mr-2 mb-2 mb-lg-0">
            <summary className="btn" role="button" aria-haspopup="menu">
              Orden
              <TriangleDownIcon className="ml-1" />
            </summary>

            <div role="menu" className="dropdown-menu dropdown-menu-sw mt-1" style={{ width: 200 }}>
              {(Object.keys(SORT_LABEL) as Sort[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="menuitemradio"
                  aria-checked={sort === option}
                  className="dropdown-item btn-link"
                  onClick={(event) => {
                    setSort(option)
                    event.currentTarget.closest('details')?.removeAttribute('open')
                  }}
                >
                  <CheckIcon
                    className={`mr-2 ${sort === option ? '' : 'v-hidden'}`}
                    aria-hidden="true"
                  />
                  {SORT_LABEL[option]}
                </button>
              ))}
            </div>
          </details>
        </div>
      </div>

      {/* `#js-clear-filters` on the live site, which hides it until something
          is set — there it is a link back to the assignment path, here there
          is no URL state to go back to */}
      {dirty && (
        <div className="mt-3">
          <button type="button" className="btn-link Link Link--muted" onClick={clear}>
            <XIcon className="mr-1" />
            Limpiar la búsqueda, los filtros y el orden
          </button>
        </div>
      )}

      {/* `<div class="mt-3">` around the list on the live site */}
      <div className="Box Box--condensed mt-3">
        <div className="Box-header">
          <div className="d-table col-12">
            <div className="Box-title col-6 d-table-cell">{title}</div>
            <div className="col-6 d-table-cell text-right color-fg-muted text-small">
              {filtered.length === rows.length
                ? `${rows.length}`
                : `${filtered.length} de ${rows.length}`}
            </div>
          </div>
        </div>

        <div className="Box-body">
          {filtered.length === 0 ? (
            <p className="color-fg-muted text-center my-3 mb-0">
              Ninguna fila coincide con los filtros.
            </p>
          ) : (
            <div className="assignment-repo-list pb-2">
              {filtered.map((row) => (
                <RepoListItem key={row.key} row={row} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function compareBy(sort: Sort): (a: RepoRow, b: RepoRow) => number {
  if (sort === 'az') return (a, b) => a.name.localeCompare(b.name, 'es')
  if (sort === 'za') return (a, b) => b.name.localeCompare(a.name, 'es')

  // "from the most recently updated assignment to the least recently updated".
  // A row with no commit of its own has no date to sort by and goes last, in
  // both directions — it is not the newest thing on the page, and it is not the
  // oldest either, it is simply absent.
  const direction = sort === 'newest' ? -1 : 1

  return (a, b) => {
    const left = a.snapshot?.latestCommitAt?.getTime()
    const right = b.snapshot?.latestCommitAt?.getTime()
    if (left === undefined && right === undefined) return a.name.localeCompare(b.name, 'es')
    if (left === undefined) return 1
    if (right === undefined) return -1
    return (left - right) * direction
  }
}

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set)
  if (!next.delete(value)) next.add(value)
  return next
}

/**
 * One of the live site's `action-menu`s with `menuitemcheckbox` items. Built on
 * the `<details>` dropdown the port already ships, because the live markup is
 * a `@primer/view-components` web component the port deliberately does not
 * depend on (see the CSS note in app/globals.css).
 */
function CheckboxMenu<T extends string>({
  label,
  heading,
  options,
  selected,
  onToggle,
  grouped = false,
}: {
  label: string
  heading: string
  options: { value: T; label: string; description: string }[]
  selected: Set<T>
  onToggle: (value: T) => void
  /** Sits inside the BtnGroup, joined to the search field on its right */
  grouped?: boolean
}) {
  return (
    <details
      className={`dropdown details-reset details-overlay ${
        grouped ? 'BtnGroup-parent' : 'd-inline-block mr-2 mb-2 mb-lg-0'
      }`}
    >
      <summary
        className={`btn ${grouped ? 'BtnGroup-item' : ''}`}
        role="button"
        aria-haspopup="menu"
      >
        {label}
        {selected.size > 0 && <span className="Counter ml-1">{selected.size}</span>}
        <TriangleDownIcon className="ml-1" />
      </summary>

      <div role="menu" className="dropdown-menu mt-1" style={{ width: 260 }}>
        <div className="dropdown-header px-3 py-1 color-fg-muted text-small">{heading}</div>

        {options.map((option) => (
          <label key={option.value} className="dropdown-item d-block">
            <input
              type="checkbox"
              className="mr-2"
              checked={selected.has(option.value)}
              onChange={() => onToggle(option.value)}
            />
            {option.label}
            <span className="d-block color-fg-muted text-small" style={{ marginLeft: '1.4rem' }}>
              {option.description}
            </span>
          </label>
        ))}
      </div>
    </details>
  )
}

function RepoListItem({ row }: { row: RepoRow }) {
  const { snapshot } = row

  return (
    <div className="d-table col-12 assignment-repo-list-item">
      <div className="col-8 d-table-cell">
        <div className="d-flex width-full">
          <Visual row={row} />

          <div className={`flex-column ${row.visual === 'none' ? '' : 'ml-3'}`}>
            <div className="pb-1">
              <span className="h5 mr-2 css-truncate css-truncate-target">
                {snapshot && row.visual === 'none' ? (
                  <a href={snapshot.htmlUrl} className="Link Link--primary">
                    {row.name}
                  </a>
                ) : row.githubLogin && row.visual === 'account' && row.unlinkedAccount ? (
                  <a href={`https://github.com/${row.githubLogin}`} className="Link Link--primary">
                    {row.name}
                  </a>
                ) : (
                  row.name
                )}
              </span>
              <span className={`IssueLabel IssueLabel--big mr-2 ${TONE_CLASS[row.label.tone]}`}>
                {row.label.text}
              </span>
            </div>

            <div className="d-flex flex-items-baseline flex-wrap">
              {!row.unlinkedAccount && row.visual !== 'none' && (
                <p className="color-fg-muted mr-3 text-small mb-0">
                  {row.githubLogin ? (
                    <a href={`https://github.com/${row.githubLogin}`} className="Link Link--muted">
                      @{row.githubLogin}
                    </a>
                  ) : (
                    'Sin vincular'
                  )}
                </p>
              )}

              {row.visual === 'none' && row.members?.length === 0 && (
                <p className="color-fg-muted mr-3 text-small mb-0">Sin integrantes</p>
              )}

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
          {row.members && row.members.length > 0 && <MemberAvatars members={row.members} />}

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

function Visual({ row }: { row: RepoRow }) {
  // A team row leads with nothing, the way the live site renders it
  if (row.visual === 'none') return null

  // `_not_in_classroom`: nobody claimed this identifier, so there is no account
  if (row.visual === 'no-account') {
    return (
      <span className="d-flex flex-items-center color-fg-muted" style={{ width: 40 }}>
        <PersonIcon size={24} />
      </span>
    )
  }

  if (!row.githubLogin) {
    return (
      <span className="d-flex flex-items-center color-fg-muted" style={{ width: 40 }}>
        <MarkGithubIcon size={24} />
      </span>
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://github.com/${row.githubLogin}.png?size=80`}
      alt={`@${row.githubLogin}`}
      width={40}
      height={40}
      className="avatar circle flex-shrink-0"
    />
  )
}

/** The stacked member avatars of a team, `AvatarStack--right` as on the live site */
function MemberAvatars({
  members,
}: {
  members: { githubLogin: string | null; githubAvatarUrl: string | null }[]
}) {
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
