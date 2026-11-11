'use client'

import { useActionState, useState } from 'react'

import { EMPTY_STATE } from '@/app/classrooms/[slug]/roster/state'

import { addTeachingAssistantAction } from './actions'

/**
 * "Agregar ayudante": one field for a GitHub login. No live equivalent — the
 * live site's "Invite admins" sends the teacher to github.com to make
 * somebody an owner, which is exactly what a TA here must not be.
 */
export function AddTeachingAssistantForm({ classroomSlug }: { classroomSlug: string }) {
  const [state, action, pending] = useActionState(addTeachingAssistantAction, EMPTY_STATE)

  // Controlled, the way AddStudentsDialog keeps its textarea: React 19 resets
  // the uncontrolled fields of a `<form action>` whenever the action finishes,
  // failures included, which would throw away the login the teacher is about
  // to correct. Only a success — the one result carrying `submission` —
  // empties it, adjusted during render as React asks for state that follows
  // something from outside.
  const [login, setLogin] = useState('')
  const [handled, setHandled] = useState<string | undefined>(undefined)
  if (state.submission && state.submission !== handled) {
    setHandled(state.submission)
    setLogin('')
  }

  return (
    <form action={action}>
      <input type="hidden" name="classroom_slug" value={classroomSlug} />

      {state.error && <div className="flash flash-error mb-3">{state.error}</div>}
      {state.notice && <div className="flash flash-success mb-3">{state.notice}</div>}

      <div className="form-group my-0">
        <div className="form-group-header">
          <label htmlFor="teaching-assistant-login">Usuario de GitHub</label>
        </div>
        {/* Stacked under 544px: side by side, the button pushes the page wider */}
        <div className="form-group-body d-flex flex-column flex-sm-row flex-sm-items-center">
          <input
            id="teaching-assistant-login"
            name="login"
            type="text"
            value={login}
            onChange={(event) => setLogin(event.target.value)}
            className="form-control input-monospace mr-sm-2 mb-2 mb-sm-0"
            placeholder="usuario"
            autoComplete="off"
            spellCheck={false}
            maxLength={40}
            required
          />
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {pending ? 'Agregando…' : 'Agregar ayudante'}
          </button>
        </div>
        <p className="note">
          La cuenta tiene que existir en GitHub. No hace falta que haya entrado antes a FIUBA
          Classroom ni que sea miembro de la organización.
        </p>
      </div>
    </form>
  )
}
