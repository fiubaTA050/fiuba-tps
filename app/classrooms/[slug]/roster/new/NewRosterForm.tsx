'use client'

import Link from 'next/link'
import { useActionState, useState } from 'react'

import { createRosterAction } from '../actions'
import { IdentifiersField } from '../IdentifiersField'
import { EMPTY_STATE } from '../state'

/**
 * Port of orgs/rosters/new.html.erb.
 *
 * The "Import students from your institution" half of that screen is gone with
 * the Google Classroom and LTI integrations; what is left is the manual list,
 * which is how the cátedra loads padrones anyway.
 *
 * The original had no field for `identifier_name`: creating a roster by hand
 * always got Roster::Creator::DEFAULT_IDENTIFIER_NAME ("Identifiers"), and only
 * the Google import ever asked. Here it is asked, prefilled with "Padrón",
 * because it is the column header of every screen that follows.
 */
export function NewRosterForm({
  classroomSlug,
  defaultIdentifierName,
}: {
  classroomSlug: string
  defaultIdentifierName: string
}) {
  const [identifierName, setIdentifierName] = useState(defaultIdentifierName)
  const [identifiers, setIdentifiers] = useState('')

  const [state, formAction, pending] = useActionState(createRosterAction, EMPTY_STATE)

  return (
    <form action={formAction} className="col-md-9">
      <input type="hidden" name="classroom_slug" value={classroomSlug} />

      {state.error && <div className="flash flash-error mb-4">{state.error}</div>}

      <div className="form-group mt-0">
        <div className="form-group-header">
          <label htmlFor="identifier_name">Nombre del identificador</label>
        </div>
        <div className="form-group-body">
          <input
            id="identifier_name"
            name="identifier_name"
            type="text"
            value={identifierName}
            onChange={(event) => setIdentifierName(event.target.value)}
            maxLength={255}
            required
            autoComplete="off"
            className="form-control"
          />
        </div>
        <p className="note">
          Con qué se identifica a cada alumno en las listas de la cátedra. Padrón, mail, legajo.
        </p>
      </div>

      <IdentifiersField
        label="Pegá la lista de alumnos"
        identifierName={identifierName || 'identificador'}
        value={identifiers}
        onChange={setIdentifiers}
      />

      {/* The original closed this form with `d-flex flex-items-center border-top
          pt-5`; the hairline is dropped because the Box above already draws one,
          and the gap is the `mt-5` the live pages use. `.form-actions` carries no
          spacing of its own in v22 — it is a clearfix plus `float: right` */}
      <div className="form-actions mt-5">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? 'Creando…' : 'Crear la lista'}
        </button>
        {/* 'Skip' in the original: the roster is optional and can wait */}
        <Link href={`/classrooms/${classroomSlug}`} className="btn" role="button">
          Ahora no
        </Link>
      </div>
    </form>
  )
}
