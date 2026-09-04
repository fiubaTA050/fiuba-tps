'use client'

import { LockIcon, RepoIcon } from '@primer/octicons-react'
import Link from 'next/link'
import { useActionState, useState } from 'react'

import { StarterCodeField } from '@/components/StarterCodeField'
import type { GroupingOption } from '@/lib/data/group-assignments'
import { parameterize } from '@/lib/data/slug'
import type { GitHubRepository } from '@/lib/github/repositories'

import { createGroupAssignmentAction, type CreateGroupAssignmentState } from './actions'

/**
 * Port of group_assignments/new.html.erb and its
 * group_assignments/_group_assignment_form_options.html.erb partial.
 *
 * The individual form with three things added, all from that partial: the
 * "Choose an existing set of teams" select paired with the "OR Create a new set
 * of teams" field, and the two "Team options" limits.
 */
export function NewGroupAssignmentForm({
  classroomSlug,
  templates,
  groupings,
  suggestedGroupingTitle,
}: {
  classroomSlug: string
  templates: GitHubRepository[]
  groupings: GroupingOption[]
  /** `Time.zone.now.strftime("Teams formed on %B %-d, %Y")` of the original */
  suggestedGroupingTitle: string
}) {
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [groupingId, setGroupingId] = useState('')

  const [state, formAction, pending] = useActionState<CreateGroupAssignmentState, FormData>(
    createGroupAssignmentAction,
    { error: null, field: null },
  )

  function onTitleChange(value: string) {
    setTitle(value)
    if (!slugEdited) setSlug(parameterize(value))
  }

  const errorFor = (field: CreateGroupAssignmentState['field']) =>
    state.field === field ? state.error : null

  const reusing = groupingId !== ''

  return (
    <form action={formAction}>
      <input type="hidden" name="classroom_slug" value={classroomSlug} />

      {errorFor('base') && <div className="flash flash-error mb-4">{errorFor('base')}</div>}

      <div className="Box mb-3">
        <div className="Box-body p-5">
          <div className={`form-group mt-0 ${errorFor('title') ? 'errored' : ''}`}>
            <div className="form-group-header">
              <label htmlFor="group_assignment_title">Título del trabajo práctico</label>
            </div>
            <div className="form-group-body">
              <input
                id="group_assignment_title"
                name="title"
                type="text"
                value={title}
                onChange={(event) => onTitleChange(event.target.value)}
                maxLength={60}
                required
                autoComplete="off"
                className="form-control input-block"
              />
            </div>
            {errorFor('title') && <p className="note color-fg-danger">{errorFor('title')}</p>}
          </div>

          <div className={`form-group ${errorFor('slug') ? 'errored' : ''}`}>
            <div className="form-group-header">
              <label htmlFor="group_assignment_slug">Prefijo de los repositorios</label>
            </div>
            <div className="form-group-body">
              <input
                id="group_assignment_slug"
                name="slug"
                type="text"
                value={slug}
                onChange={(event) => {
                  setSlugEdited(true)
                  setSlug(event.target.value)
                }}
                maxLength={60}
                required
                autoComplete="off"
                className="form-control input-block"
              />
            </div>
            {errorFor('slug') && <p className="note color-fg-danger">{errorFor('slug')}</p>}
            <p className="note">
              Cada repo de equipo se va a llamar <code>{slug || 'prefijo'}-equipo</code>. Como todos
              los classrooms comparten la organización de GitHub, conviene que el prefijo lleve el
              cuatrimestre.
            </p>
          </div>

          {/* The `if @group_assignment.new_record?` block of the original: the
              set of teams can be chosen only while creating */}
          <div className={`form-group ${errorFor('grouping') ? 'errored' : ''}`}>
            {groupings.length > 0 && (
              <>
                <div className="form-group-header">
                  <label htmlFor="grouping_id">Conjunto de equipos</label>
                </div>
                <div className="form-group-body">
                  <select
                    id="grouping_id"
                    name="grouping_id"
                    className="form-select input-block"
                    value={groupingId}
                    onChange={(event) => setGroupingId(event.target.value)}
                  >
                    <option value="">Crear uno nuevo</option>
                    {groupings.map((grouping) => (
                      <option key={grouping.id} value={grouping.id}>
                        {grouping.title} ({grouping.teamCount}{' '}
                        {grouping.teamCount === 1 ? 'equipo' : 'equipos'})
                      </option>
                    ))}
                  </select>
                </div>
                <p className="note">
                  Reusá los equipos de otro trabajo práctico y los alumnos no tienen que volver a armarlos.
                </p>
              </>
            )}

            {!reusing && (
              <div className={groupings.length > 0 ? 'mt-3' : ''}>
                <div className="form-group-header">
                  <label htmlFor="grouping_title">
                    {groupings.length > 0
                      ? 'Nombre del conjunto nuevo'
                      : 'Nombre del conjunto de equipos'}
                  </label>
                </div>
                <div className="form-group-body">
                  <input
                    id="grouping_title"
                    name="grouping_title"
                    type="text"
                    defaultValue={suggestedGroupingTitle}
                    required
                    autoComplete="off"
                    className="form-control input-block"
                  />
                </div>
              </div>
            )}

            {errorFor('grouping') && <p className="note color-fg-danger">{errorFor('grouping')}</p>}
          </div>

          <div className="form-group my-4">
            <div className="form-checkbox">
              <label>
                <input type="radio" name="visibility" value="private" defaultChecked />
                <div className="d-flex">
                  <LockIcon size={24} className="color-fg-attention mr-2 flex-shrink-0" />
                  <div>
                    Privado
                    <span className="d-block f6 color-fg-muted text-normal mt-1">
                      Cada entrega la ven sólo los integrantes del equipo y los owners de la
                      organización.
                    </span>
                  </div>
                </div>
              </label>
            </div>

            <div className="form-checkbox">
              <label>
                <input type="radio" name="visibility" value="public" />
                <div className="d-flex">
                  <RepoIcon size={24} className="color-fg-muted mr-2 flex-shrink-0" />
                  <div>
                    Público
                    <span className="d-block f6 color-fg-muted text-normal mt-1">
                      Las entregas quedan visibles para cualquiera.
                    </span>
                  </div>
                </div>
              </label>
            </div>
          </div>

          <h3 className="h5 mt-5 pt-4 border-top">Opcional</h3>

          <div className={`mt-3 ${errorFor('starterCode') ? 'errored' : ''}`}>
            <h4 className="h6">Starter code</h4>
            <p className="note mt-0 mb-2">
              El repo del que se clona el de cada equipo. Tiene que ser un{' '}
              <a
                href="https://docs.github.com/articles/creating-a-template-repository"
                target="_blank"
                rel="noreferrer"
              >
                template repository
              </a>
              . Dejalo vacío para arrancar de un repo sin contenido.
            </p>

            <StarterCodeField templates={templates} invalid={Boolean(errorFor('starterCode'))} />

            {errorFor('starterCode') && (
              <p className="note color-fg-danger">{errorFor('starterCode')}</p>
            )}
          </div>

          <div className="mt-4">
            <h4 className="h6">Corrección automática</h4>
            <div className="form-group-body">
              <input
                id="autograder_id"
                name="autograder_id"
                type="text"
                autoComplete="off"
                className="form-control input-block"
              />
            </div>
            <p className="note">
              El id que el corrector externo usa para elegir cómo corregir este trabajo práctico.
              Dejalo vacío si no tiene corrección automática.
            </p>
          </div>

          {/* "Team options" of the original */}
          <div className="mt-4">
            <h4 className="h6">Equipos</h4>

            <div className={`form-group ${errorFor('maxMembers') ? 'errored' : ''}`}>
              <div className="form-group-header">
                <label htmlFor="max_members">Máximo de integrantes por equipo</label>
              </div>
              <div className="form-group-body">
                <input
                  id="max_members"
                  name="max_members"
                  type="number"
                  min={1}
                  autoComplete="off"
                  className="form-control"
                  placeholder="Sin límite"
                />
              </div>
              {errorFor('maxMembers') && (
                <p className="note color-fg-danger">{errorFor('maxMembers')}</p>
              )}
            </div>

            <div className={`form-group ${errorFor('maxTeams') ? 'errored' : ''}`}>
              <div className="form-group-header">
                <label htmlFor="max_teams">Máximo de equipos</label>
              </div>
              <div className="form-group-body">
                <input
                  id="max_teams"
                  name="max_teams"
                  type="number"
                  min={1}
                  autoComplete="off"
                  className="form-control"
                  placeholder="Sin límite"
                />
              </div>
              {errorFor('maxTeams') && (
                <p className="note color-fg-danger">{errorFor('maxTeams')}</p>
              )}
            </div>
          </div>

          <div className="mt-4">
            <h4 className="h6">Link de invitación</h4>
            <div className="form-checkbox">
              <label>
                <input type="checkbox" name="invitations_enabled" defaultChecked />
                Permitir que los alumnos acepten el trabajo práctico
              </label>
            </div>
          </div>

          <div className="mt-4">
            <h4 className="h6">Permisos del alumno</h4>
            <div className="form-checkbox">
              <label>
                <input type="checkbox" name="students_are_repo_admins" />
                Darle permiso de admin a cada integrante sobre el repo del equipo
              </label>
              <p className="note">Cambiar esto después no afecta a los repos ya creados.</p>
            </div>
          </div>
        </div>
      </div>

      <div className="d-flex mt-5 mb-6 flex-justify-end">
        <Link href={`/classrooms/${classroomSlug}`} className="btn mr-2" role="button">
          Cancelar
        </Link>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? 'Creando…' : 'Crear trabajo práctico grupal'}
        </button>
      </div>
    </form>
  )
}
