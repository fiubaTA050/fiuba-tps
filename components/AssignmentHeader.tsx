import { DotFillIcon, OrganizationIcon, PersonIcon, TriangleDownIcon } from '@primer/octicons-react'
import Link from 'next/link'

import { InvitationLink } from '@/components/InvitationLink'
import type { GitHubRepository } from '@/lib/github/repositories'

/**
 * The band that tops an assignment dashboard: title, starter code, what kind of
 * assignment it is, whether it is active, the invitation link and the actions.
 *
 * Copied from the live classroom.github.com dashboard, like ClassroomShell and
 * for the same reason — the archived Rails view puts the same information in a
 * sidebar the cátedra has never seen. Markup down to the `border-bottom py-3
 * pt-md-4 mb-3` and the two-column `d-flex flex-justify-between` under the
 * title.
 *
 * Three of the live buttons are not here and are not coming:
 *  - **Sync assignments**, which opens a pull request on every student
 *    repository against the starter code. Nothing propagates to existing
 *    repositories in this port, deliberately (DA-10).
 *  - **Autograding** ("No tests to run"), not ported.
 *  - **Reuse assignment**, which copies an assignment into another classroom.
 * The live "Delete" is here but sends the teacher to the edit screen's danger
 * zone rather than opening its own modal: there is exactly one delete flow and
 * `docs/edicion-y-borrado-de-assignments.md` describes it there.
 */
export function AssignmentHeader({
  title,
  group,
  active,
  starterCodeRepoId,
  starterCode,
  editHref,
  invitationUrl,
  invitationsEnabled,
  disabledReason,
}: {
  title: string
  group: boolean
  active: boolean
  /** Null when the assignment starts from an empty repository */
  starterCodeRepoId: number | null
  /** The repository itself, null when it is set but unreachable on GitHub */
  starterCode: GitHubRepository | null
  editHref: string
  invitationUrl: string
  invitationsEnabled: boolean
  /** Why the link is disabled, shown under it. Null when it is enabled */
  disabledReason: string | null
}) {
  return (
    <div className="border-bottom py-3 pt-md-4 mb-3">
      <div className="flex-auto">
        <h1>{title}</h1>

        <div className="color-fg-muted">
          {starterCodeRepoId === null ? (
            <span>Sin starter code: cada {group ? 'equipo' : 'alumno'} arranca de un repo vacío</span>
          ) : starterCode ? (
            <>
              <span>Starter code de </span>
              <a href={starterCode.htmlUrl} className="Link">
                {starterCode.fullName}
              </a>
            </>
          ) : (
            // NullGitHubRepository: the template was deleted or the App lost
            // access to it
            <span className="color-fg-attention">
              Starter code inaccesible: el repo se borró o la App perdió acceso
            </span>
          )}
        </div>

        <div className="d-flex flex-justify-between mt-2 flex-wrap">
          <div className="d-flex flex-items-center flex-wrap color-fg-muted">
            <div className="d-flex flex-items-center mr-4">
              {group ? (
                <OrganizationIcon className="mr-1" />
              ) : (
                <PersonIcon className="mr-1" />
              )}
              <span>Trabajo práctico {group ? 'grupal' : 'individual'}</span>
            </div>

            <div className="d-flex flex-items-center">
              <DotFillIcon
                className={`mr-1 ${active ? 'color-fg-success' : 'color-fg-attention'}`}
              />
              {/* The live site's "Assignment status", read-only here: it is set
                  from the edit screen, which is where the archived
                  `toggle_invitations` checkbox went */}
              <span>{active ? 'Activo' : 'Inactivo'}</span>
            </div>
          </div>

          <div className="d-flex flex-wrap flex-items-start mt-3 mt-md-0">
            {/* 43ch is the live site's own width, and it is what makes a short
                invitation link readable whole without selecting it */}
            <div className="d-inline-block mr-2">
              <InvitationLink url={invitationUrl} disabled={!invitationsEnabled} width="43ch" />
            </div>

            <details className="dropdown details-reset details-overlay d-inline-block">
              <summary className="btn btn-sm" role="button" aria-haspopup="menu">
                Editar
                <TriangleDownIcon className="ml-1" />
              </summary>

              <div
                role="menu"
                className="dropdown-menu dropdown-menu-sw mt-1"
                style={{ width: 200 }}
              >
                <Link href={editHref} className="dropdown-item" role="menuitem">
                  Editar el trabajo práctico
                </Link>
                <div role="none" className="dropdown-divider" />
                <Link href={`${editHref}#borrar`} className="dropdown-item" role="menuitem">
                  Borrar el trabajo práctico
                </Link>
              </div>
            </details>
          </div>
        </div>

        {disabledReason && (
          <p className="color-fg-attention f6 mt-2 mb-0 text-right">{disabledReason}</p>
        )}
      </div>
    </div>
  )
}
