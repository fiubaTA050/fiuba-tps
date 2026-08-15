'use client'

import { useActionState } from 'react'

import type { Team, TeamMember } from '@/lib/data/groups'
import { EMPTY_STATE } from '@/lib/form'

import { moveMemberAction } from './actions'

/**
 * One student, with the select that moves them.
 *
 * The original's screen offered drag and drop between teams
 * (`groupings/show.html.erb`), but its handler never posted anything —
 * `team-management.js:28` only updates the counter in the DOM. A select and a
 * button do the same job, work without JavaScript, and say out loud where the
 * student is going, which matters because the move is not free: it takes their
 * access to one repository and grants it on another.
 */
export function MemberRow({
  classroomSlug,
  groupingSlug,
  member,
  currentTeamId,
  teams,
}: {
  classroomSlug: string
  groupingSlug: string
  member: TeamMember
  currentTeamId: number
  teams: Team[]
}) {
  const [state, action, pending] = useActionState(moveMemberAction, EMPTY_STATE)

  return (
    <div className="Box-row">
      <form action={action} className="d-md-flex flex-items-center flex-justify-between">
        <input type="hidden" name="classroom_slug" value={classroomSlug} />
        <input type="hidden" name="grouping_slug" value={groupingSlug} />
        <input type="hidden" name="user_id" value={member.userId} />

        <div className="d-flex flex-items-center col-md-5 mb-2 mb-md-0">
          {member.githubAvatarUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={member.githubAvatarUrl}
              className="avatar avatar-small mr-2"
              height={24}
              width={24}
              alt={`@${member.githubLogin}`}
            />
          )}
          <a href={`https://github.com/${member.githubLogin}`}>@{member.githubLogin}</a>
        </div>

        <div className="d-flex flex-items-center col-md-7 flex-justify-end">
          <select
            name="target_group_id"
            className="form-select mr-2"
            defaultValue={currentTeamId}
            disabled={pending}
          >
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.title}
              </option>
            ))}
            <option value="">Sacarlo del equipo</option>
          </select>

          <button type="submit" className="btn btn-sm" disabled={pending}>
            {pending ? 'Moviendo…' : 'Mover'}
          </button>
        </div>
      </form>

      {state.error && <p className="note color-fg-danger mt-2 mb-0">{state.error}</p>}
      {state.notice && <p className="note mt-2 mb-0">{state.notice}</p>}
    </div>
  )
}
