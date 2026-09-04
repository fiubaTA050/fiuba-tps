'use client'

import { LockIcon, RepoIcon } from '@primer/octicons-react'
import Link from 'next/link'
import { useActionState, useState } from 'react'

import { StarterCodeField } from '@/components/StarterCodeField'
import type { AssignmentListItem } from '@/lib/data/assignments'
import type { GitHubRepository } from '@/lib/github/repositories'

import {
  deleteAssignmentAction,
  updateAssignmentAction,
  type EditAssignmentState,
} from './actions'

const EMPTY: EditAssignmentState = { error: null, field: null }

/**
 * Port of assignments/edit.html.erb, which reuses the same
 * assignments/_assignment_form_options.html.erb partial as the new screen.
 *
 * Three differences from NewAssignmentForm, all deliberate:
 *
 *  - The invitations checkbox becomes the live site's **"Assignment status"**
 *    dropdown, Active / Inactive. That is where the archived
 *    `toggle_invitations` went, and skipping it also skips its bug — it posted
 *    to `/assignments/:slug/toggle_invitations` for group assignments too, so
 *    the checkbox spun forever (issue #2555).
 *  - The title never rewrites the prefix. On the new screen that is a
 *    convenience; here the prefix is already published and a typo fix in the
 *    title must not move it.
 *  - The danger zone at the bottom, from edit.html.erb:22-24.
 */
export function EditAssignmentForm({
  classroomSlug,
  assignment,
  templates,
  starterCodeFullName,
  entrega,
}: {
  classroomSlug: string
  assignment: AssignmentListItem
  templates: GitHubRepository[]
  /** `owner/name` read from GitHub, or '' when there is none or it is gone */
  starterCodeFullName: string
  /** The assignment's single checkpoint, already in Argentine time */
  entrega: { enabled: boolean; deadlineInput: string; submissionCount: number }
}) {
  const [title, setTitle] = useState(assignment.title)
  const [slug, setSlug] = useState(assignment.slug)
  const [submissionsEnabled, setSubmissionsEnabled] = useState(entrega.enabled)

  const [state, formAction, pending] = useActionState<EditAssignmentState, FormData>(
    updateAssignmentAction,
    EMPTY,
  )

  const [deleteState, deleteAction, deleting] = useActionState<EditAssignmentState, FormData>(
    deleteAssignmentAction,
    EMPTY,
  )

  const errorFor = (field: EditAssignmentState['field']) =>
    state.field === field ? state.error : null

  return (
    <>
      <form action={formAction}>
        <input type="hidden" name="classroom_slug" value={classroomSlug} />
        {/* The slug identifies the row, and the field beside it may rename it */}
        <input type="hidden" name="assignment_slug" value={assignment.slug} />

        {errorFor('base') && <div className="flash flash-error mb-4">{errorFor('base')}</div>}

        <div className="Box mb-3">
          <div className="Box-body p-5">
            <div className={`form-group mt-0 ${errorFor('title') ? 'errored' : ''}`}>
              <div className="form-group-header">
                <label htmlFor="assignment_title">Título del trabajo práctico</label>
              </div>
              <div className="form-group-body">
                <input
                  id="assignment_title"
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

            {/* "Assignment status" of the live site's edit screen */}
            <div className="form-group">
              <div className="form-group-header">
                <label htmlFor="assignment_status">Estado del trabajo práctico</label>
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
                Un trabajo práctico inactivo no lo pueden aceptar los alumnos. Ponelo en inactivo cuando
                venció la entrega. Lo que ya se aceptó no se toca: cada repo sigue siendo del
                alumno.
              </p>
            </div>

            <div className={`form-group ${errorFor('slug') ? 'errored' : ''}`}>
              <div className="form-group-header">
                <label htmlFor="assignment_slug">Prefijo de los repositorios</label>
              </div>
              <div className="form-group-body">
                <input
                  id="assignment_slug"
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
              {/* The original does not propagate `slug` either — `Editor#perform`
                  has no `when "slug"` — so this only ever applies to new repos */}
              <p className="note">
                Los repos nuevos se van a llamar <code>{slug || 'prefijo'}-usuario</code>. Los que
                ya existen conservan el nombre con el que se crearon.
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
                        Cada entrega la ven sólo su autor y los owners de la organización.
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
              {/* Divergence from Editor#update_attribute_for_all_assignment_repos,
                  whose only `when` enqueued AssignmentRepositoryVisibilityJob */}
              <p className="note">
                Cambiar la visibilidad vale para los repos que se creen de acá en adelante. Los ya
                creados quedan como están.
              </p>
            </div>

            {/* The entrega. No equivalent in the archived original, which hangs
                one `deadline` off the assignment and freezes submissions with a
                Sidekiq job; here the entrega is a row of its own and the
                student is the one who confirms. See docs/entregas.md. */}
            <h3 className="h5 mt-5 pt-4 border-top">Entregas</h3>

            <div className="form-group mt-3">
              <div className="form-checkbox">
                <label>
                  <input
                    type="checkbox"
                    name="submissions_enabled"
                    checked={submissionsEnabled}
                    onChange={(event) => setSubmissionsEnabled(event.target.checked)}
                  />
                  Los alumnos pueden confirmar su entrega
                </label>
                <p className="note">
                  Cada alumno elige una rama, un tag o un commit de su repositorio y confirma. Eso
                  congela el árbol que vas a corregir. Sin esto, no hay nada que entregar.
                </p>
              </div>
            </div>

            <div className="form-group">
              <div className="form-group-header">
                <label htmlFor="deadline_at">Fecha de entrega</label>
              </div>
              <div className="form-group-body">
                <input
                  type="datetime-local"
                  id="deadline_at"
                  name="deadline_at"
                  className="form-control"
                  defaultValue={entrega.deadlineInput}
                  disabled={!submissionsEnabled}
                />
              </div>
              <p className="note">
                Opcional, y en hora de Argentina. La fecha <strong>no cierra la entrega</strong>:
                las que lleguen después se aceptan y quedan marcadas como tarde. Para que nadie
                entregue más, poné el trabajo práctico en Inactivo.
              </p>
              {entrega.submissionCount > 0 && (
                <p className="note">
                  Ya hay {entrega.submissionCount}{' '}
                  {entrega.submissionCount === 1 ? 'entrega confirmada' : 'entregas confirmadas'}.
                  Mientras existan no se pueden apagar las entregas.
                </p>
              )}
            </div>

            <h3 className="h5 mt-5 pt-4 border-top">Opcional</h3>

            <div className={`mt-3 ${errorFor('starterCode') ? 'errored' : ''}`}>
              <h4 className="h6">Starter code</h4>
              <p className="note mt-0 mb-2">
                El repo del que se clona el de cada alumno. Tiene que ser un{' '}
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
              <p className="note">
                Cambiarlo vale para los repos que se creen de acá en adelante.
              </p>
            </div>

            <div className="mt-4">
              <h4 className="h6">Corrección automática</h4>
              <div className="form-group-body">
                <input
                  id="autograder_id"
                  name="autograder_id"
                  type="text"
                  defaultValue={assignment.autograderId ?? ''}
                  autoComplete="off"
                  className="form-control input-block"
                />
              </div>
              <p className="note">
                El id que el corrector externo usa para elegir cómo corregir este trabajo
                práctico. Dejalo vacío si no tiene corrección automática.
              </p>
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
                  Darle permiso de admin a cada alumno sobre su repo
                </label>
                <p className="note">Cambiar esto no afecta a los repos ya creados.</p>
              </div>
            </div>
          </div>
        </div>

        <div className="d-flex mt-5 flex-justify-end">
          <Link
            href={`/classrooms/${classroomSlug}/assignments/${assignment.slug}`}
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

      {/* The `boxed-group danger` of edit.html.erb:20-25. Its modal asked you to
          type the assignment name because deleting took the students'
          repositories with it; here nothing leaves GitHub, so a confirm is the
          proportionate warning — the same call RosterEntryRow made. */}
      {/* The dashboard's "Borrar el trabajo práctico" menu item scrolls here */}
      <div id="borrar" className="Box Box--danger mt-6 mb-6">
        <div className="Box-header">
          <h3 className="Box-title color-fg-danger">Borrar este trabajo práctico</h3>
        </div>
        <div className="Box-body">
          <p className="color-fg-muted">
            Desaparece del classroom y su link de invitación deja de funcionar. El título y el
            prefijo quedan libres para otro trabajo práctico.
          </p>
          <p className="color-fg-muted">
            <strong>Los repositorios de los alumnos no se borran</strong>: quedan en la
            organización de GitHub, con sus entregas.
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
                if (!window.confirm(`¿Borrar el trabajo práctico "${assignment.title}"?`)) {
                  event.preventDefault()
                }
              }}
            >
              {deleting ? 'Borrando…' : 'Borrar este trabajo práctico'}
            </button>
          </form>
        </div>
      </div>
    </>
  )
}
