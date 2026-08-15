'use client'

import { PlusIcon } from '@primer/octicons-react'
import { useActionState } from 'react'

import type { TeamOption } from '@/lib/data/group-invitations'
import { EMPTY_STATE } from '@/lib/form'

import { acceptTeamAction } from './actions'

/**
 * Port of the body of `group_assignment_invitations/show.html.erb`: the grid of
 * teams with a Join button each, and the "OR Create a new team" field below.
 *
 * The original laid the grid out by hand, splitting the collection into odd and
 * even halves with `cycle` and dropping each into a `one-half` column. That
 * exists because Primer v10 had no grid; `d-flex flex-wrap` does the same thing
 * without splitting the list in two, and keeps the teams in title order down
 * the page instead of alternating between columns.
 *
 * One form for everything, like the roster screen: each Join button carries its
 * team id as its own `name`/`value`, so the browser submits only the one
 * pressed.
 */
export function TeamPicker({
  invitationKey,
  teams,
  teamLimitReached,
  maxMembers,
}: {
  invitationKey: string
  teams: TeamOption[]
  teamLimitReached: boolean
  maxMembers: number | null
}) {
  const [state, action, pending] = useActionState(acceptTeamAction, EMPTY_STATE)

  return (
    <form action={action}>
      <input type="hidden" name="key" value={invitationKey} />

      {state.error && <div className="flash flash-error mb-3">{state.error}</div>}

      {teams.length > 0 && (
        <>
          <h3 className="f4 mb-2">Sumate a un equipo</h3>

          <div className="d-flex flex-wrap" style={{ gap: '1rem' }}>
            {teams.map((team) => (
              <div className="Box col-12 col-md-5 flex-auto" key={team.id}>
                <div className="Box-header d-flex flex-items-center flex-justify-between">
                  <div>
                    <h4 className="Box-title">{team.title}</h4>
                    <span className="f6 color-fg-muted">
                      {team.members.length}
                      {maxMembers === null ? '' : ` de ${maxMembers}`}{' '}
                      {team.members.length === 1 ? 'integrante' : 'integrantes'}
                    </span>
                  </div>

                  <button
                    type="submit"
                    name="group_id"
                    value={team.id}
                    className="btn btn-sm"
                    disabled={team.full || pending}
                  >
                    {team.full ? 'Lleno' : 'Sumarme'}
                  </button>
                </div>

                <div className="Box-row d-flex flex-wrap" style={{ gap: '0.25rem' }}>
                  {team.members.length === 0 ? (
                    <span className="f6 color-fg-muted">Todavía no se sumó nadie.</span>
                  ) : (
                    team.members.map((member) => (
                      <a
                        key={member.userId}
                        href={`https://github.com/${member.githubLogin}`}
                        className="tooltipped tooltipped-s"
                        aria-label={member.githubLogin ?? 'Sin cuenta'}
                      >
                        {member.githubAvatarUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={member.githubAvatarUrl}
                            className="avatar avatar-small"
                            height={30}
                            width={30}
                            alt={`@${member.githubLogin}`}
                          />
                        ) : (
                          <span className="f6">@{member.githubLogin}</span>
                        )}
                      </a>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>

          <hr className="my-4" />
        </>
      )}

      <h3 className="f4 mb-2">{teams.length > 0 ? 'O creá uno nuevo' : 'Creá tu equipo'}</h3>

      <div className="d-flex" style={{ gap: '0.5rem' }}>
        <input
          type="text"
          name="group_title"
          className="form-control input-block"
          placeholder={teamLimitReached ? 'Se llegó al límite de equipos' : 'Nombre del equipo'}
          disabled={teamLimitReached || pending}
          autoComplete="off"
          maxLength={39}
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={teamLimitReached || pending}
          style={{ whiteSpace: 'nowrap' }}
        >
          <PlusIcon className="mr-1" />
          {pending ? 'Creando…' : 'Crear equipo'}
        </button>
      </div>
    </form>
  )
}
