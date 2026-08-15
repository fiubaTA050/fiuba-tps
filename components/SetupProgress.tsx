'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import type { InviteStatusValue } from '@/db/schema'

/**
 * The `#create-repo-progress` box of `assignment_invitations/setup.html.erb`,
 * plus what `app/assets/javascripts/setup.js` did around it.
 *
 * The original subscribed to an ActionCable channel and, in its `connected()`
 * callback, POSTed `create_repo` to start the work. There is no websocket here,
 * so the POST happens on mount and progress comes from the `progress` endpoint
 * the original kept as its fallback. The retry button is that same POST, which
 * is what it was there too.
 *
 * The one thing that is not in the original: `retry` as a state distinct from
 * an error. When a whole cohort clicks the invitation at once GitHub answers
 * with a secondary rate limit and a `retry-after`, and coming back when it says
 * is what keeps a hundred students from stampeding. See
 * docs/creacion-de-repos.md.
 */

/** Where in the bar each status sits, and what the line under the title says */
const STAGES: Record<InviteStatusValue, { label: string; percent: number; failed?: boolean }> = {
  unaccepted: { label: 'Sin aceptar', percent: 0 },
  accepted: { label: 'En espera', percent: 10 },
  waiting: { label: 'En espera', percent: 10 },
  creating_repo: { label: 'Creando el repositorio', percent: 60 },
  importing_starter_code: { label: 'Copiando el starter code', percent: 80 },
  completed: { label: 'Listo', percent: 100 },
  errored_creating_repo: { label: 'Falló la creación del repositorio', percent: 0, failed: true },
  errored_importing_starter_code: {
    label: 'Falló la copia del starter code',
    percent: 0,
    failed: true,
  },
}

const POLL_INTERVAL_MS = 2000

/**
 * How long a setup status can sit unchanged before the screen stops pretending
 * something is happening. It matches the lock expiry in
 * `createStudentRepository`: past it, a retry is allowed to take over, so the
 * button has to be there to press. The whole job is ~3 s, so anything near this
 * is abandoned work, not slow work.
 */
const STUCK_AFTER_MS = 5 * 60 * 1000

type CreateResult =
  | { status: 'completed'; repoUrl: string }
  | { status: 'working' }
  | { status: 'retry'; retryAfter: number }
  | { status: 'errored'; error: string }
  | { status: 'unaccepted' }

export function SetupProgress({
  basePath,
  initialStatus,
  initialRepoUrl,
  repoName,
  teamName,
}: {
  /** `/assignment-invitations/<key>` or `/group-assignment-invitations/<key>` */
  basePath: string
  initialStatus: InviteStatusValue
  initialRepoUrl: string | null
  repoName: string
  /** Set on a group assignment: the repository belongs to the team, not to them */
  teamName?: string | null
}) {
  const [status, setStatus] = useState(initialStatus)
  const [repoUrl, setRepoUrl] = useState(initialRepoUrl)
  const [error, setError] = useState<string | null>(null)
  const [retryAt, setRetryAt] = useState<number | null>(null)
  const [working, setWorking] = useState(false)
  /** When the status last moved, to notice work that was abandoned mid-flight */
  const [changedAt, setChangedAt] = useState(() => Date.now())
  const [stuck, setStuck] = useState(false)

  // Strict Mode mounts effects twice in development. The lock in
  // `createStudentRepository` would turn the second one into a harmless
  // `working`, but firing two requests that each take ~3 s is wasteful enough
  // to be worth not doing.
  const started = useRef(false)

  const create = useCallback(async () => {
    setWorking(true)
    setError(null)

    try {
      const response = await fetch(`${basePath}/create-repo`, { method: 'POST' })

      if (!response.ok) return

      const result = (await response.json()) as CreateResult

      if (result.status === 'completed') {
        setStatus('completed')
        setRepoUrl(result.repoUrl)
      } else if (result.status === 'retry') {
        // GitHub asked us to wait. Jitter so the cohort does not come back in
        // lockstep and trip the same limit again.
        setStatus('accepted')
        setRetryAt(Date.now() + result.retryAfter * 1000 + Math.random() * 3000)
      } else if (result.status === 'errored') {
        setStatus('errored_creating_repo')
        setError(result.error)
      }
    } catch {
      // A dropped request is not worth a message: the polling below notices
      // either way, and the retry button is there.
    } finally {
      setWorking(false)
    }
  }, [basePath])

  // The `connected()` callback of the original
  useEffect(() => {
    if (started.current || initialStatus === 'completed') return
    started.current = true
    void create()
  }, [create, initialStatus])

  // The rate limit wait: come back exactly when GitHub said to
  useEffect(() => {
    if (retryAt === null) return

    const timer = setTimeout(() => {
      setRetryAt(null)
      void create()
    }, Math.max(0, retryAt - Date.now()))

    return () => clearTimeout(timer)
  }, [retryAt, create])

  // The `progress` endpoint, for the states this tab did not cause: another tab
  // holding the lock, or one day a worker doing the building.
  useEffect(() => {
    if (status === 'completed' || retryAt !== null) return

    const timer = setInterval(async () => {
      try {
        const response = await fetch(`${basePath}/progress`)
        if (!response.ok) return

        const progress = (await response.json()) as {
          status: InviteStatusValue
          repoUrl: string | null
        }

        setStatus((previous) => {
          if (previous !== progress.status) {
            setChangedAt(Date.now())
            setStuck(false)
          }
          return progress.status
        })
        if (progress.repoUrl) setRepoUrl(progress.repoUrl)
      } catch {
        // Next tick asks again
      }
    }, POLL_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [basePath, status, retryAt])

  // Nothing has moved for long enough that the lock has expired server-side.
  // Offer the button rather than leaving the student watching a bar that will
  // never fill — which is the state `fiubaTA050-labs` is full of.
  useEffect(() => {
    if (status === 'completed' || retryAt !== null) return

    const timer = setTimeout(() => setStuck(true), STUCK_AFTER_MS - (Date.now() - changedAt))
    return () => clearTimeout(timer)
  }, [status, retryAt, changedAt])

  const stage = STAGES[status]
  const waiting = retryAt !== null

  const done = status === 'completed' && repoUrl
  const owner = teamName ? `El repositorio de ${teamName}` : 'Tu repositorio'

  return (
    <>
      {/* "Your assignment repository is being set up. This might take a while."
          Lives here rather than on the page: the page renders once, before the
          repository exists, and a heading that still says "se está preparando"
          over a finished bar is worse than no heading. */}
      <h3 className="f3 text-normal mt-4 mb-3">
        {done ? `${owner} está listo.` : `${owner} se está preparando. Esto puede demorar.`}
      </h3>

      <div className="Box">
        <div className="Box-row">
          <h4 className="mb-0">Creando el repositorio</h4>
        </div>

        <div className="Box-row">
          <p className={`mb-0 ${stage.failed || stuck ? 'color-fg-danger' : 'color-fg-muted'}`}>
            {waiting
              ? 'Hay muchos alumnos aceptando a la vez. Reintentamos en unos segundos.'
              : stuck
                ? 'Esto está tardando más de lo normal. Probá de nuevo.'
                : stage.label}
          </p>
          {error && <p className="note color-fg-danger mb-0 mt-1">{error}</p>}
        </div>

        <div className="p-3">
          {/* app/assets/stylesheets/components/progress-bar.scss */}
          <span className="progress-bar v-align-middle">
            <span className="progress" style={{ width: `${stage.percent}%` }} />
          </span>
        </div>
      </div>

      {done ? (
        // The body of `success.html.erb`, which is all this port needs of it
        <div className="flash flash-success mt-3">
          {owner} está listo: <a href={repoUrl}>{repoUrl}</a>
        </div>
      ) : (
        <p className="note mt-3">
          Se va a llamar <strong className="text-mono">{repoName}</strong>. Cuando esté listo lo
          vas a ver acá, sin tener que hacer nada más.
        </p>
      )}

      {(stage.failed || stuck) && !waiting && (
        // `#retry-button`, which the original showed only once the job errored
        <button type="button" className="btn mt-3" onClick={() => void create()} disabled={working}>
          {working ? 'Reintentando…' : 'Reintentar'}
        </button>
      )}
    </>
  )
}
