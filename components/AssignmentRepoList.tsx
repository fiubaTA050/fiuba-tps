'use client'

import {
  CheckIcon,
  DotFillIcon,
  GitCommitIcon,
  MarkGithubIcon,
  PersonIcon,
  RepoIcon,
  SearchIcon,
  TriangleDownIcon,
  XCircleFillIcon,
  XIcon,
} from '@primer/octicons-react'
import { type ComponentProps, useMemo, useRef, useState } from 'react'

import { hasSubmitted, type RepoRow, type SubmissionTone } from '@/lib/assignment-rows'
import type { SubmissionRow } from '@/lib/data/submissions'
import { formatArgentina } from '@/lib/dates'

import { LinkToStudentDialog } from './LinkToStudentDialog'
import { Pagination } from './Pagination'

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
 * One of the live filters has nothing behind it: "Passing/Failing" is
 * autograding and is not ported. The "On-time/Late" halves of the submission
 * filter needed deadlines, which checkpoints now give the individual
 * dashboard — its own `CheckboxMenu` below only renders when a row actually
 * carries submission data, which the group dashboard's rows do not yet (no
 * group checkpoints).
 *
 * **Pagination is client-side for the same reason**, over the rows the filters
 * left. The live site puts it in the URL, as Kaminari does — see
 * components/Pagination for the markup and the window it draws.
 */

/**
 * Rows per page, measured on a saved copy of the live dashboard: 30 items and
 * a second page. Kaminari's `default_per_page` in the archived original is 20;
 * the deployment the cátedra uses every day shows 30.
 */
const PER_PAGE = 30

/** The live "Filter by submission" */
type SubmissionFilter = 'submitted' | 'not_submitted'
/**
 * The live "On-time/Late" halves of the submission filter, split into their
 * own menu here rather than merged into `SubmissionFilter`'s checkboxes,
 * since a row can be late only once it has confirmed at all.
 */
type TimingFilter = 'on_time' | 'late'
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

/**
 * The dots the live submission menu puts beside each option, with its own
 * inline colours: the subtle green of "Submitted" and the subtle red of "Not
 * submitted". They are hardcoded there too, and they are the same two shades
 * the `IssueLabel` of a row lands on.
 */
const DOT_SUBMITTED = '#DAFBE1'
const DOT_NOT_SUBMITTED = '#FFEBE9'

const TONE_CLASS: Record<SubmissionTone, string> = {
  success: 'color-bg-success',
  danger: 'color-bg-danger',
  attention: 'color-bg-attention',
  // v22 ships no neutral IssueLabel background; the subtle canvas is what the
  // live site's own grey labels land on
  neutral: 'color-bg-subtle color-fg-muted',
}

/**
 * What an unlinked-account row needs to offer "Link to student". Absent on the
 * group dashboard, which has no unlinked accounts of its own yet, and on a
 * classroom with no roster, where there is nothing to link to.
 */
export type LinkToStudent = Omit<
  ComponentProps<typeof LinkToStudentDialog>,
  'userId' | 'login'
>

export function AssignmentRepoList({
  title,
  rows,
  classroomSlug,
  assignmentSlug,
  linkToStudent,
}: {
  title: string
  rows: RepoRow[]
  /** Only used to build the submission-history request of a confirmed row */
  classroomSlug: string
  assignmentSlug: string
  linkToStudent?: LinkToStudent
}) {
  const [query, setQuery] = useState('')
  const [submission, setSubmission] = useState<Set<SubmissionFilter>>(new Set())
  const [timing, setTiming] = useState<Set<TimingFilter>>(new Set())
  const [accepted, setAccepted] = useState<Set<AcceptedFilter>>(new Set())
  const [unlinked, setUnlinked] = useState<Set<UnlinkedFilter>>(new Set())
  const [sort, setSort] = useState<Sort>('az')
  const [page, setPage] = useState(1)
  const listTop = useRef<HTMLDivElement>(null)

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

      if (timing.size > 0) {
        // Nothing to be on-time or late about without a confirmation
        if (row.submission == null) return false
        const state: TimingFilter = row.submission.late ? 'late' : 'on_time'
        if (!timing.has(state)) return false
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
  }, [rows, query, submission, timing, accepted, unlinked, sort])

  // Back to the first page whenever the list underneath changes — a filter, a
  // sort or a search. `filtered` is a memo, so its identity is that change.
  const [lastFiltered, setLastFiltered] = useState(filtered)
  if (lastFiltered !== filtered) {
    setLastFiltered(filtered)
    setPage(1)
  }

  const pageCount = Math.ceil(filtered.length / PER_PAGE)
  const visible = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE)

  function goToPage(next: number) {
    setPage(next)
    // The live site navigates, so the browser lands at the top of the new
    // page; here the rows are replaced under a paginator that sits below the
    // fold, and without this the teacher would be left staring at its end
    listTop.current?.scrollIntoView({ block: 'start' })
  }

  const dirty =
    query !== '' ||
    submission.size > 0 ||
    timing.size > 0 ||
    accepted.size > 0 ||
    unlinked.size > 0 ||
    sort !== 'az'

  function clear() {
    setQuery('')
    setSubmission(new Set())
    setTiming(new Set())
    setAccepted(new Set())
    setUnlinked(new Set())
    setSort('az')
  }

  // Only the individual dashboard's rows carry submission data today — the
  // group one always leaves `submission` undefined (no group checkpoints yet)
  const hasTimingData = rows.some((row) => row.submission !== undefined)

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
              {
                value: 'submitted',
                label: 'Entregado',
                description: 'Subieron algún commit propio',
                dot: DOT_SUBMITTED,
              },
              {
                value: 'not_submitted',
                label: 'Sin entregar',
                description: 'Todavía no subieron nada',
                dot: DOT_NOT_SUBMITTED,
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

              {/* Always rendered, as on the live site, which shows it on an
                  empty field too */}
              <button
                type="button"
                className="FormControl-input-trailingAction"
                aria-label="Limpiar la búsqueda"
                onClick={() => setQuery('')}
              >
                <XCircleFillIcon />
              </button>
            </div>
          </div>
        </div>

        <div className="d-flex flex-wrap mb-2 mb-lg-0">
          {/* No dots and no descriptions: on the live site only the submission
              menu carries them */}
          <CheckboxMenu
            label="Filtrar por cuentas sin vincular"
            heading="Filtrar por vínculo:"
            options={[
              { value: 'identifiers', label: 'Identificadores' },
              { value: 'accounts', label: 'Cuentas de GitHub' },
            ]}
            selected={unlinked}
            onToggle={(value) => setUnlinked(toggle(unlinked, value))}
          />

          <CheckboxMenu
            label="Filtrar por aceptación"
            heading="Filtrar por aceptación:"
            options={[
              { value: 'accepted', label: 'Aceptaron' },
              { value: 'unaccepted', label: 'No aceptaron' },
            ]}
            selected={accepted}
            onToggle={(value) => setAccepted(toggle(accepted, value))}
          />

          {/* Only where entregas are tracked — the individual dashboard, for
              now. Without a confirmation there is nothing to be on-time or
              late about, so this stays hidden on the group one. */}
          {hasTimingData && (
            <CheckboxMenu
              label="Filtrar por vencimiento"
              heading="Filtrar por vencimiento:"
              options={[
                { value: 'on_time', label: 'A tiempo' },
                { value: 'late', label: 'Tarde' },
              ]}
              selected={timing}
              onToggle={(value) => setTiming(toggle(timing, value))}
            />
          )}

          <details className="dropdown details-reset details-overlay d-inline-block mr-2 mb-2 mb-lg-0">
            <summary className="btn" role="button" aria-haspopup="menu">
              Orden
              <TriangleDownIcon className="ml-1" />
            </summary>

            <div className="ActionMenu-anchor ActionMenu-anchor--right">
              <div className="Overlay Overlay--size-auto">
                <div className="Overlay-body Overlay-body--paddingNone">
                  <ul role="menu" className="ActionListWrap ActionListWrap--inset">
                    <li className="ActionList-sectionDivider" role="presentation">
                      <div className="ActionList-sectionDivider-title">Ordenar por:</div>
                    </li>

                    {(Object.keys(SORT_LABEL) as Sort[]).map((option) => (
                      <li key={option} role="none" className="ActionListItem">
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={sort === option}
                          className="ActionListContent ActionListContent--visual16"
                          onClick={(event) => {
                            setSort(option)
                            event.currentTarget.closest('details')?.removeAttribute('open')
                          }}
                        >
                          <span className="ActionListItem-visual ActionListItem-action--leading">
                            <CheckIcon className="ActionListItem-singleSelectCheckmark" />
                          </span>
                          <span className="ActionListItem-label">{SORT_LABEL[option]}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
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
      <div className="Box Box--condensed mt-3" ref={listTop}>
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
              {visible.map((row) => (
                <RepoListItem
                  key={row.key}
                  row={row}
                  classroomSlug={classroomSlug}
                  assignmentSlug={assignmentSlug}
                  linkToStudent={linkToStudent}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Outside the Box, where the live site puts it */}
      <Pagination page={page} pageCount={pageCount} onChange={goToPage} label={title} />
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
 * One of the live site's `action-menu`s: an `Overlay` holding an `ActionList`
 * of `menuitemcheckbox` items, each a checkmark column that only shows when
 * the item is on, an optional coloured dot, the label, and an optional
 * description under it.
 *
 * The markup is the live site's, the behaviour is a plain `<details>`: its
 * `action-menu` is a `@primer/view-components` web component, and the port
 * depends on none of that package (see the CSS note in app/globals.css).
 *
 * Only the submission menu carries dots and descriptions on the live site; the
 * others are label-and-checkmark, and so are ours.
 */
function CheckboxMenu<T extends string>({
  label,
  heading,
  options,
  selected,
  onToggle,
  grouped = false,
  alignRight = false,
}: {
  label: string
  heading: string
  options: { value: T; label: string; description?: string; dot?: string }[]
  selected: Set<T>
  onToggle: (value: T) => void
  /** Sits inside the BtnGroup, joined to the search field on its right */
  grouped?: boolean
  alignRight?: boolean
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

      <div className={`ActionMenu-anchor ${alignRight ? 'ActionMenu-anchor--right' : ''}`}>
        <div className="Overlay Overlay--size-auto">
          <div className="Overlay-body Overlay-body--paddingNone">
            <ul role="menu" className="ActionListWrap ActionListWrap--inset">
              <li className="ActionList-sectionDivider" role="presentation">
                <div className="ActionList-sectionDivider-title">{heading}</div>
              </li>

              {options.map((option) => (
                <li key={option.value} role="none" className="ActionListItem">
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={selected.has(option.value)}
                    onClick={() => onToggle(option.value)}
                    className={`ActionListContent ActionListContent--visual16 ${
                      option.description ? 'ActionListContent--blockDescription' : ''
                    }`}
                  >
                    <span className="ActionListItem-visual ActionListItem-action--leading">
                      <CheckIcon className="ActionListItem-singleSelectCheckmark" />
                    </span>

                    {option.dot && (
                      <span className="ActionListItem-visual ActionListItem-visual--leading">
                        {/* The colour goes on a wrapper, not the octicon:
                            `.ActionListItem-visual` sets `fill` to the muted
                            foreground, which an svg inherits over its own
                            currentColor */}
                        <span style={{ color: option.dot, fill: option.dot }}>
                          <DotFillIcon size={24} />
                        </span>
                      </span>
                    )}

                    {option.description ? (
                      <span className="ActionListItem-descriptionWrap">
                        <span className="ActionListItem-label">{option.label}</span>
                        <span className="ActionListItem-description">{option.description}</span>
                      </span>
                    ) : (
                      <span className="ActionListItem-label">{option.label}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </details>
  )
}

function RepoListItem({
  row,
  classroomSlug,
  assignmentSlug,
  linkToStudent,
}: {
  row: RepoRow
  classroomSlug: string
  assignmentSlug: string
  linkToStudent?: LinkToStudent
}) {
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

              {/* No saved copy of the live site to port this from — AGENTS.md
                  notes its own "Late" label isn't ported yet either. New UI. */}
              {row.submission?.late && (
                <span className="IssueLabel IssueLabel--big mr-2 color-bg-danger">Tarde</span>
              )}
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

              {/* Where the handle would go, because on these rows the handle is
                  already the title: `_unlinked_user.html.erb:17` */}
              {row.unlinkedAccount && linkToStudent && row.userId !== undefined && (
                <LinkToStudentDialog
                  {...linkToStudent}
                  userId={row.userId}
                  login={row.githubLogin}
                />
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

            <SubmissionHistoryDetails
              row={row}
              classroomSlug={classroomSlug}
              assignmentSlug={assignmentSlug}
            />
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

/** `SubmissionRow` as it comes back over JSON: dates are still strings */
type RawSubmissionRow = Omit<SubmissionRow, 'committedAt' | 'submittedAt'> & {
  committedAt: string
  submittedAt: string
}

/**
 * "Ver entregas anteriores", fetched on demand — see docs/entregas.md and
 * lib/data/submissions.ts:findSubmissionHistory on why this is per-row and
 * on click, not eager for the whole cohort: a single repo can carry many
 * confirmations, and shipping that for every row would inflate the page for
 * rows nobody opens. Same `<details>` idiom as SubmissionPanel.tsx's own
 * history disclosure, just fetched instead of pre-loaded — there's only one
 * confirmed student behind that one, a whole cohort behind this one.
 */
function SubmissionHistoryDetails({
  row,
  classroomSlug,
  assignmentSlug,
}: {
  row: RepoRow
  classroomSlug: string
  assignmentSlug: string
}) {
  const [state, setState] = useState<'closed' | 'loading' | 'error' | SubmissionRow[]>('closed')

  // Nothing confirmed, nothing to show — and no repo id to ask about anyway
  if (row.submission == null || row.repoId === null) return null

  return (
    <details
      className="mt-1"
      onToggle={(event) => {
        if (!event.currentTarget.open || state !== 'closed') return
        setState('loading')
        fetch(`/api/classrooms/${classroomSlug}/assignments/${assignmentSlug}/submissions/${row.repoId}`)
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error())))
          .then(({ history }: { history: RawSubmissionRow[] }) =>
            setState(
              history.map((entry) => ({
                ...entry,
                committedAt: new Date(entry.committedAt),
                submittedAt: new Date(entry.submittedAt),
              })),
            ),
          )
          .catch(() => setState('error'))
      }}
    >
      <summary className="btn-link f6">Ver entregas anteriores</summary>

      {state === 'loading' && <p className="color-fg-muted f6 mt-1 mb-0">Cargando…</p>}
      {state === 'error' && (
        <p className="color-fg-muted f6 mt-1 mb-0">No pudimos cargar el historial.</p>
      )}
      {Array.isArray(state) &&
        (state.length === 0 ? (
          <p className="color-fg-muted f6 mt-1 mb-0">No hay entregas registradas.</p>
        ) : (
          <ul className="list-style-none mt-1">
            {state.map((entry) => (
              <li key={entry.id} className="py-1 border-bottom color-fg-muted f6">
                {row.snapshot ? (
                  <a
                    href={`${row.snapshot.htmlUrl}/tree/${entry.sha}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-mono"
                  >
                    {entry.sha.slice(0, 7)}
                  </a>
                ) : (
                  <span className="text-mono">{entry.sha.slice(0, 7)}</span>
                )}{' '}
                <span className="color-fg-muted">({entry.ref})</span> el{' '}
                {formatCommitDate(entry.submittedAt)}
                {entry.late && <span className="IssueLabel color-bg-attention ml-2">Tarde</span>}
              </li>
            ))}
          </ul>
        ))}
    </details>
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

/**
 * `May 6, 2026 23:54` on the live site, in the locale the rest of the port uses.
 *
 * Through lib/dates so the hour is the cátedra's and not the viewer's: this
 * used to leave `timeZone` unset, which on Vercel meant UTC.
 */
function formatCommitDate(date: Date): string {
  return formatArgentina(date)
}
