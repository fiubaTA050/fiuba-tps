'use client'

import { LockIcon, RepoIcon } from '@primer/octicons-react'
import Link from 'next/link'
import { useActionState, useState } from 'react'

import { StarterCodeField } from '@/components/StarterCodeField'
import type { GroupAssignmentListItem } from '@/lib/data/group-assignments'
import type { GitHubRepository } from '@/lib/github/repositories'

import {
  deleteGroupAssignmentAction,
  updateGroupAssignmentAction,
  type EditGroupAssignmentState,
} from './actions'

const EMPTY: EditGroupAssignmentState = { error: null, field: null }

/**
 * Port of group_assignments/edit.html.erb. The individual edit form plus the
 * two "Team options" limits, and with the set of teams shown as read-only data:
 * the original only offers it inside `if @group_assignment.new_record?`.
 */
export function EditGroupAssignmentForm({
  classroomSlug,
  assignment,
  templates,
  starterCodeFullName,
  teamCount,
}: {
  classroomSlug: string
  assignment: GroupAssignmentListItem
  templates: GitHubRepository[]
  starterCodeFullName: string
  /** What `max_teams_less_than_group_count` is measured against */
  teamCount: number
}) {
  const [title, setTitle] = useState(assignment.title)
  const [slug, setSlug] = useState(assignment.slug)

  const [state, formAction, pending] = useActionState<EditGroupAssignmentState, FormData>(
    updateGroupAssignmentAction,
    EMPTY,
  )

  const [deleteState, deleteAction, deleting] = useActionState<EditGroupAssignmentState, FormData>(
    deleteGroupAssignmentAction,
    EMPTY,
  )

  const errorFor = (field: EditGroupAssignmentState['field']) =>
    state.field === field ? state.error : null

  return (
    <>
      <form action={formAction}>
        <input type="hidden" name="classroom_slug" value={classroomSlug} />
        <input type="hidden" name="assignment_slug" value={assignment.slug} />

        {errorFor('base') && <div className="flash flash-error mb-4">{errorFor('base')}</div>}

        <div className="Box mb-3">
          <div className="Box-body p-5">
            <div className={`form-group mt-0 ${errorFor('title') ? 'errored' : ''}`}>
              <div className="form-group-header">
                <label htmlFor="group_assignment_title">Título del assignment</label>
              </div>
              <div className="form-group-body">
                <input
                  id="group_assignment_title"
                  name="title"
                  type="text"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={60}
                  required
                  autoComplete="off"
                  className="form-control input-block"
                />
              </div>
              {errorFor('title') && <p className="note color-fg-danger">{errorFor('title')}</p>}
            </div>

            <div className="form-group">
              <div className="form-group-header">
                <label htmlFor="assignment_status">Estado del assignment</label>
              </div>
              <div className="form-group-body">
                <select
                  id="assignment_status"
                  name="assignment_status"
                  className="form-select"
                  defaultValue={assignment.invitationsEnabled ? 'active' : 'inactive'}
                >
                  <option value="active">Activo</option>
                  <option value="inactive">Inactivo</option>
                </select>
              </div>
              <p className="note">
                Un assignment inactivo no lo pueden aceptar los alumnos. Ponelo en inactivo cuando
                venció la entrega. Los equipos que ya aceptaron conservan su repo.
              </p>
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
                  onChange={(event) => setSlug(event.target.value)}
                  maxLength={60}
                  required
                  autoComplete="off"
                  className="form-control input-block"
                />
              </div>
              {errorFor('slug') && <p className="note color-fg-danger">{errorFor('slug')}</p>}
              <p className="note">
                Los repos nuevos se van a llamar <code>{slug || 'prefijo'}-equipo</code>. Los que ya
                existen conservan el nombre con el que se crearon.
              </p>
            </div>

            {/* Read-only: the original's form only offers the set of teams while
                `new_record?`, and moving an assignment to another set would
                orphan every repository already created under it. */}
            <div className="form-group">
              <div className="form-group-header">
                <label htmlFor="grouping">Conjunto de equipos</label>
              </div>
              <div className="form-group-body">
                <input
                  id="grouping"
                  type="text"
                  value={`${assignment.grouping.title} (${teamCount} ${
                    teamCount === 1 ? 'equipo' : 'equipos'
                  })`}
                  readOnly
                  disabled
                  className="form-control input-block"
                />
              </div>
              <p className="note">
                El conjunto de equipos no se puede cambiar después de crear el assignment.{' '}
                <Link href={`/classrooms/${classroomSlug}/groupings/${assignment.grouping.slug}`}>
                  Administrar los equipos
                </Link>
                .
              </p>
            </div>

            <div className="form-group my-4">
              <div className="form-checkbox">
                <label>
                  <input
                    type="radio"
                    name="visibility"
                    value="private"
                    defaultChecked={!assignment.publicRepo}
                  />
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
                  <input
                    type="radio"
                    name="visibility"
                    value="public"
                    defaultChecked={assignment.publicRepo}
                  />
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
              <p className="note">
                Cambiar la visibilidad vale para los repos que se creen de acá en adelante. Los ya
                creados quedan como están.
              </p>
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

              <StarterCodeField
                templates={templates}
                invalid={Boolean(errorFor('starterCode'))}
                initialValue={starterCodeFullName}
              />

              {errorFor('starterCode') && (
                <p className="note color-fg-danger">{errorFor('starterCode')}</p>
              )}
              <p className="note">Cambiarlo vale para los repos que se creen de acá en adelante.</p>
            </div>

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
                    defaultValue={assignment.maxMembers ?? ''}
                    autoComplete="off"
                    className="form-control"
                    placeholder="Sin límite"
                  />
                </div>
                {errorFor('maxMembers') && (
                  <p className="note color-fg-danger">{errorFor('maxMembers')}</p>
                )}
                <p className="note">
                  Sólo se aplica a partir de ahora: los equipos que ya lo superan quedan como están.
                </p>
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
                    defaultValue={assignment.maxTeams ?? ''}
                    autoComplete="off"
                    className="form-control"
                    placeholder="Sin límite"
                  />
                </div>
                {errorFor('maxTeams') && (
                  <p className="note color-fg-danger">{errorFor('maxTeams')}</p>
                )}
                {/* validate :max_teams_less_than_group_count, edit branch */}
                <p className="note">
                  No puede ser menor que los {teamCount}{' '}
                  {teamCount === 1 ? 'equipo que ya existe' : 'equipos que ya existen'}.
                </p>
              </div>
            </div>

            <div className="mt-4">
              <h4 className="h6">Permisos del alumno</h4>
              <div className="form-checkbox">
                <label>
                  <input
                    type="checkbox"
                    name="students_are_repo_admins"
                    defaultChecked={assignment.studentsAreRepoAdmins}
                  />
                  Darle permiso de admin a cada integrante sobre el repo del equipo
                </label>
                <p className="note">Cambiar esto no afecta a los repos ya creados.</p>
              </div>
            </div>
          </div>
        </div>

        <div className="d-flex mt-5 flex-justify-end">
          <Link
            href={`/classrooms/${classroomSlug}/group-assignments/${assignment.slug}`}
            className="btn mr-2"
            role="button"
          >
            Cancelar
          </Link>
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {pending ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </div>
      </form>

      {/* The dashboard's "Borrar assignment" menu item scrolls here */}
      <div id="borrar" className="Box Box--danger mt-6 mb-6">
        <div className="Box-header">
          <h3 className="Box-title color-fg-danger">Borrar este assignment grupal</h3>
        </div>
        <div className="Box-body">
          <p className="color-fg-muted">
            Desaparece del classroom y su link de invitación deja de funcionar. El conjunto de
            equipos <strong>{assignment.grouping.title}</strong> queda, porque es del classroom y
            puede estar compartido con otro TP.
          </p>
          <p className="color-fg-muted">
            <strong>Los repositorios de los equipos no se borran</strong>: quedan en la organización
            de GitHub, con sus entregas.
          </p>

          {deleteState.error && <div className="flash flash-error mb-3">{deleteState.error}</div>}

          <form action={deleteAction}>
            <input type="hidden" name="classroom_slug" value={classroomSlug} />
            <input type="hidden" name="assignment_slug" value={assignment.slug} />
            <button
              type="submit"
              className="btn btn-danger"
              disabled={deleting}
              onClick={(event) => {
                if (!window.confirm(`¿Borrar el assignment "${assignment.title}"?`)) {
                  event.preventDefault()
                }
              }}
            >
              {deleting ? 'Borrando…' : 'Borrar este assignment grupal'}
            </button>
          </form>
        </div>
      </div>
    </>
  )
}
