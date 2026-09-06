'use client'

import { LockIcon, RepoIcon } from '@primer/octicons-react'
import Link from 'next/link'
import { useActionState, useState } from 'react'

import { StarterCodeField } from '@/components/StarterCodeField'
import { parameterize } from '@/lib/data/slug'
import type { GitHubRepository } from '@/lib/github/repositories'

import { createAssignmentAction, type CreateAssignmentState } from './actions'

/**
 * Port of assignments/new.html.erb and its
 * assignments/_assignment_form_options.html.erb partial.
 *
 * Everything of the original's partial is here except the deadline, which only
 * does anything paired with a job runner that Vercel does not give us, and the
 * template-vs-importer radios, which have nothing left to choose between since
 * GitHub retired the Source Imports API.
 */
export function NewAssignmentForm({
  classroomSlug,
  templates,
}: {
  classroomSlug: string
  templates: GitHubRepository[]
}) {
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)

  const [state, formAction, pending] = useActionState<CreateAssignmentState, FormData>(
    createAssignmentAction,
    { error: null, field: null },
  )

  /**
   * Port of assignments-slug.js, which bound `change paste keyup click` on the
   * title and refilled the slug on every keystroke.
   *
   * Divergence: there it overwrote the slug unconditionally, so a teacher who
   * adjusted the prefix by hand lost it the moment they went back to fix a
   * typo in the title. Here the title stops driving the slug once the slug has
   * been touched.
   */
  function onTitleChange(value: string) {
    setTitle(value)
    if (!slugEdited) setSlug(parameterize(value))
  }

  const errorFor = (field: CreateAssignmentState['field']) =>
    state.field === field ? state.error : null

  return (
    <form action={formAction}>
      <input type="hidden" name="classroom_slug" value={classroomSlug} />

      {errorFor('base') && <div className="flash flash-error mb-4">{errorFor('base')}</div>}

      {/* The live page frames the fields in `Box > Box-body p-5` and leaves the
          buttons outside it, at the bottom right */}
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
              onChange={(event) => onTitleChange(event.target.value)}
              maxLength={60}
              required
              autoComplete="off"
              className="form-control input-block"
            />
          </div>
          {/* Not Primer's `.error`: in v22 that class is an absolutely
              positioned bubble, and the original's `.errored` form group is
              already what turns the label and the border red. */}
          {errorFor('title') && <p className="note color-fg-danger">{errorFor('title')}</p>}
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
          {/* t('assignment_form.slug_note'), plus the naming rule from
              Exercise#default_repo_name, which the original left implicit */}
          <p className="note">
            Cada repo de alumno se va a llamar <code>{slug || 'prefijo'}-usuario</code>. Sólo
            letras, números, guiones y guiones bajos.
          </p>
        </div>

        <div className="form-group my-4">
          {/* The original defaulted to public when the org had no private repos
              left in its plan (FormView#public_is_checked?). Private repos are
              free and unlimited for organizations now, so that condition always
              lands on private — which is the sane default for a course anyway. */}
          <div className="form-checkbox">
            <label>
              <input type="radio" name="visibility" value="private" defaultChecked />
              <div className="d-flex">
                <LockIcon size={24} className="color-fg-attention mr-2 flex-shrink-0" />
                <div>
                  Privado
                  <span className="d-block f6 color-fg-muted text-normal mt-1">
                    Cada entrega la ven sólo su autor y los owners de la organización. Cambiar
                    esto después no afecta a los repos ya creados.
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

          {/* Port of the "Add starter code" field. What is gone from the
              original are the template-vs-importer radios: GitHub retired the
              Source Imports API, so cloning a template is the only path left
              and there is nothing to choose between. */}
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

            <StarterCodeField templates={templates} invalid={Boolean(errorFor('starterCode'))} />

            {errorFor('starterCode') && (
              <p className="note color-fg-danger">{errorFor('starterCode')}</p>
            )}
            <p className="note">
              Puede estar en cualquier organización donde la App esté instalada, o ser un repo
              público de cualquier lado.
            </p>
          </div>

          <div className="mt-4">
            <h4 className="h6">Link de invitación</h4>
            <div className="form-checkbox">
              <label>
                <input type="checkbox" name="invitations_enabled" defaultChecked />
                Permitir que los alumnos acepten el trabajo práctico
              </label>
              <p className="note">
                Mientras esté habilitado, cualquiera con el link puede aceptar el trabajo práctico.
              </p>
            </div>
          </div>

          <div className="mt-4">
            <h4 className="h6">Permisos del alumno</h4>
            <div className="form-checkbox">
              <label>
                <input type="checkbox" name="students_are_repo_admins" />
                Darle permiso de admin a cada alumno sobre su repo
              </label>
              <p className="note">
                Cambiar esto después no afecta a los repos ya creados.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* `mt-5` is the live page's own gap between the box and its buttons */}
      <div className="d-flex mt-5 mb-6 flex-justify-end">
        <Link href={`/classrooms/${classroomSlug}`} className="btn mr-2" role="button">
          Cancelar
        </Link>
        <button
          type="submit"
          id="assignment_submit"
          className="btn btn-primary"
          disabled={pending}
        >
          {pending ? 'Creando…' : 'Crear trabajo práctico'}
        </button>
      </div>
    </form>
  )
}
