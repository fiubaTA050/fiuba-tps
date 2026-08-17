import { MarkGithubIcon } from '@primer/octicons-react'

import { LinkToStudentDialog } from '@/components/LinkToStudentDialog'
import type { UnlinkedAccount } from '@/lib/data/rosters'

import { linkAccountAction } from './actions'

/**
 * One GitHub account of the classroom that holds no identifier, in the layout
 * of `orgs/rosters/_unlinked_user.html.erb`: avatar and @login on the left, and
 * "Link to student" pushed to the right.
 *
 * The handle is the whole title here — there is no identifier to put above it,
 * which is exactly the problem the teacher opens this tab to fix.
 */
export function UnlinkedAccountRow({
  account,
  classroomSlug,
  identifierName,
  entries,
}: {
  account: UnlinkedAccount
  classroomSlug: string
  /** The roster's column name, "Padrón" by default */
  identifierName: string
  /** The identifiers nobody holds, for the dialog */
  entries: { id: number; identifier: string }[]
}) {
  return (
    <div className="py-2 d-flex col-12 flex-justify-between flex-items-center flex-wrap">
      <div className="d-flex flex-items-center">
        {account.githubLogin ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`https://github.com/${account.githubLogin}.png?size=92`}
            className="avatar avatar-user mr-3"
            height={46}
            width={46}
            alt=""
          />
        ) : (
          <span className="d-flex flex-items-center flex-justify-center color-fg-muted mr-3">
            <MarkGithubIcon size={24} />
          </span>
        )}

        {account.githubLogin ? (
          // `.student-login`, which the live site paints in the default
          // foreground rather than link blue
          <a className="Link Link--primary" href={`https://github.com/${account.githubLogin}`}>
            <h4>@{account.githubLogin}</h4>
          </a>
        ) : (
          // NullGitHubUser: the row still has to be linkable, or the identifier
          // it belongs to stays empty forever
          <h4 className="color-fg-muted">Cuenta desconocida</h4>
        )}
      </div>

      <div className="d-flex flex-justify-end">
        <LinkToStudentDialog
          userId={account.id}
          login={account.githubLogin}
          classroomSlug={classroomSlug}
          identifierName={identifierName}
          entries={entries}
          action={linkAccountAction}
          triggerClassName="btn btn-sm"
        />
      </div>
    </div>
  )
}
