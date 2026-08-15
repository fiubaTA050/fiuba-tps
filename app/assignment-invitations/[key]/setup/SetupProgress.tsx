'use client'

import { useEffect, useState } from 'react'

import type { InviteStatusValue } from '@/db/schema'

/**
 * The `#create-repo-progress` box of `assignment_invitations/setup.html.erb`,
 * driven by the `progress` endpoint the original polled from
 * `app/javascript/assignment_setup.js`.
 *
 * The original also carried a `retry-button` that POSTed to `create_repo` and
 * re-enqueued the job. There is no job to re-enqueue, so it is not here; the
 * errored states it belonged to are equally unreachable, and the box below
 * renders them only so the future job has somewhere to land.
 */

/** Where in the bar each status sits, and what the line under the title says */
const STAGES: Record<InviteStatusValue, { label: string; percent: number; failed?: boolean }> = {
  unaccepted: { label: 'Sin aceptar', percent: 0 },
  accepted: { label: 'En espera', percent: 0 },
  waiting: { label: 'En espera', percent: 0 },
  creating_repo: { label: 'Creando el repositorio', percent: 50 },
  importing_starter_code: { label: 'Copiando el starter code', percent: 75 },
  completed: { label: 'Listo', percent: 100 },
  errored_creating_repo: { label: 'Falló la creación del repositorio', percent: 0, failed: true },
  errored_importing_starter_code: {
    label: 'Falló la copia del starter code',
    percent: 0,
    failed: true,
  },
}

/** SetupStatus::SETUP_STATUSES — the states worth asking about again */
const PENDING: InviteStatusValue[] = ['accepted', 'waiting', 'creating_repo', 'importing_starter_code']

const POLL_INTERVAL_MS = 5000

export function SetupProgress({
  invitationKey,
  initialStatus,
  repoName,
}: {
  invitationKey: string
  initialStatus: InviteStatusValue
  repoName: string
}) {
  const [status, setStatus] = useState(initialStatus)
  const [repoUrl, setRepoUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!PENDING.includes(status)) return

    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/assignment-invitations/${invitationKey}/progress`)
        if (!response.ok) return

        const progress = (await response.json()) as {
          status: InviteStatusValue
          repoUrl: string | null
        }

        setStatus(progress.status)
        setRepoUrl(progress.repoUrl)
      } catch {
        // A dropped request is not worth showing: the next tick asks again
      }
    }, POLL_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [invitationKey, status])

  const stage = STAGES[status]

  return (
    <>
      <div className="Box">
        <div className="Box-row">
          <h4 className="mb-0">Creando el repositorio</h4>
        </div>

        <div className="Box-row">
          <p className={`mb-0 ${stage.failed ? 'color-fg-danger' : 'color-fg-muted'}`}>
            {stage.label}
          </p>
        </div>

        <div className="p-3">
          {/* app/assets/stylesheets/components/progress-bar.scss */}
          <span className="progress-bar v-align-middle">
            <span className="progress" style={{ width: `${stage.percent}%` }} />
          </span>
        </div>
      </div>

      {status === 'completed' && repoUrl ? (
        // The body of `success.html.erb`, which is all this port needs of it
        <p className="mt-3">
          Tu repositorio: <a href={repoUrl}>{repoUrl}</a>
        </p>
      ) : (
        <p className="note mt-3">
          Se va a llamar <strong className="text-mono">{repoName}</strong>. Cuando esté listo lo
          vas a ver acá, sin tener que hacer nada más.
        </p>
      )}
    </>
  )
}
