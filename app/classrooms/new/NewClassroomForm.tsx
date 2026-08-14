'use client'

import { CheckIcon, PlusIcon } from '@primer/octicons-react'
import { useActionState, useState } from 'react'

import type { GitHubOrganization } from '@/lib/github/organizations'

import { createClassroomAction, type CreateClassroomState } from './actions'

/**
 * Steps 3 to 5: pick the organization, name it, create it.
 *
 * Port of organizations/new.html.erb (the org grid) merged with
 * organizations/setup.html.erb (the name field).
 *
 * In the original the grid was a form that submitted on clicking an org — the
 * title was generated as `<org>-classroom-1` and only later, on the setup
 * screen, did the teacher change it. Here the name is asked before creating,
 * so clicking an org selects it instead of submitting.
 *
 * The other difference from the original: the orgs listed are the ones where
 * the GitHub App is installed, not every org the user belongs to. That is why
 * the last card leads to installing the App on another org rather than to the
 * OAuth App's permissions screen.
 */
export function NewClassroomForm({
  organizations,
  installUrl,
}: {
  organizations: GitHubOrganization[]
  installUrl: string
}) {
  const [selected, setSelected] = useState<GitHubOrganization | null>(
    organizations.filter((organization) => organization.admin).length === 1
      ? (organizations.find((organization) => organization.admin) ?? null)
      : null,
  )

  const [state, formAction, pending] = useActionState<CreateClassroomState, FormData>(
    createClassroomAction,
    { error: null },
  )

  return (
    <form action={formAction}>
      {state.error && (
        <div className="flash flash-error mb-4">
          <span>{state.error}</span>
        </div>
      )}

      <div className="Subhead Subhead--spacious">
        <h2 className="Subhead-heading">Elegí la organización</h2>
        <div className="Subhead-description">
          Los repos de los alumnos se crean dentro de esta organización de GitHub.
        </div>
      </div>

      <div className="d-flex flex-wrap gutter-condensed">
        {organizations.map((organization) => (
          <div key={organization.installationId} className="col-6 col-md-4 mb-4">
            <OrganizationCard
              organization={organization}
              selected={selected?.githubId === organization.githubId}
              onSelect={() => setSelected(organization)}
            />
          </div>
        ))}

        {/* Port of the "Grant organization access" card, now pointing at the
            GitHub App installation */}
        <div className="col-6 col-md-4 mb-4">
          <a
            href={installUrl}
            className="d-flex flex-column flex-justify-center height-full border rounded-2 text-center text-bold p-5 color-bg-default hover-grow"
          >
            <span className="organization-grant-access-text">
              <PlusIcon size={24} className="d-block mx-auto mb-2" />
              Instalar en otra organización
            </span>
          </a>
        </div>
      </div>

      {/* Port of organizations/setup.html.erb */}
      <div className="Subhead Subhead--spacious mt-4">
        <h2 className="Subhead-heading">Nombre del classroom</h2>
      </div>

      <div className="col-12 col-md-6">
        <input type="hidden" name="github_id" value={selected?.githubId ?? ''} />
        <input type="hidden" name="installation_id" value={selected?.installationId ?? ''} />

        <div className="form-group">
          <div className="form-group-header">
            <label htmlFor="title">Dale un nombre descriptivo</label>
          </div>
          <div className="form-group-body">
            <input
              id="title"
              name="title"
              type="text"
              maxLength={255}
              required
              disabled={!selected}
              className="form-control input-contrast input-block"
              placeholder={
                selected ? `${selected.login}-2026-2c` : 'Elegí primero una organización'
              }
            />
          </div>
          <p className="note">
            Suele incluir la materia y el cuatrimestre. Una organización puede tener varios
            classrooms, pero no dos con el mismo nombre.
          </p>
        </div>

        <div className="mt-4">
          <button type="submit" className="btn btn-primary" disabled={!selected || pending}>
            {pending ? 'Creando…' : 'Crear classroom'}
          </button>
        </div>
      </div>
    </form>
  )
}

/** Port of _organization_select.html.erb and _disabled_organization_select.html.erb */
function OrganizationCard({
  organization,
  selected,
  onSelect,
}: {
  organization: GitHubOrganization
  selected: boolean
  onSelect: () => void
}) {
  const avatar = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={organization.avatarUrl}
      className="avatar d-block mx-auto mb-2"
      width={100}
      height={100}
      alt={organization.login}
    />
  )

  if (!organization.admin) {
    return (
      <div
        className="d-block width-full height-full text-center border rounded-2 box-shadow-medium color-bg-subtle p-3 tooltipped tooltipped-s"
        aria-label="No sos owner de esta organización"
      >
        <span className="color-fg-muted">
          {avatar}
          <span title={organization.login}>{organization.login}</span>
        </span>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`d-block width-full height-full text-center hover-grow border rounded-2 box-shadow-medium color-bg-default p-3 ${
        selected ? 'organization-select--selected' : ''
      }`}
    >
      {avatar}
      <span title={organization.login}>
        {selected && <CheckIcon className="mr-1 color-fg-success" />}
        {organization.login}
      </span>
    </button>
  )
}
