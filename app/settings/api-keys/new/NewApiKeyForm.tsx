'use client'

import { useActionState } from 'react'

import { AVAILABLE_SCOPES, SCOPE_DESCRIPTIONS } from '@/lib/data/api-key-scopes'

import { createApiKeyAction } from '../actions'
import { EMPTY_STATE } from '../state'

/** On success this redirects to /settings/api-keys (see actions.ts), so the
 * only state this form ever renders itself is a validation error. */
export function NewApiKeyForm() {
  const [state, formAction, pending] = useActionState(createApiKeyAction, EMPTY_STATE)

  return (
    <form action={formAction} className="col-md-6">
      <div className="form-group">
        <div className="form-group-header">
          <label htmlFor="label">Nombre de la key</label>
        </div>
        <div className="form-group-body">
          <input
            id="label"
            name="label"
            type="text"
            maxLength={255}
            required
            autoFocus
            defaultValue={state.label}
            placeholder="ej. PC de casa"
            className="form-control input-block"
          />
        </div>
        <p className="note">
          Te sirve para identificarla después, por ejemplo si generás una por máquina.
        </p>
      </div>

      <div className="form-group">
        <div className="form-group-header">
          <label>Permisos</label>
        </div>
        <div className="form-group-body">
          {AVAILABLE_SCOPES.map((scope) => (
            <div className="form-checkbox" key={scope}>
              <label>
                <input
                  type="checkbox"
                  name="scopes"
                  value={scope}
                  defaultChecked={state.scopes.includes(scope)}
                />
                {scope}
                <p className="note">{SCOPE_DESCRIPTIONS[scope]}</p>
              </label>
            </div>
          ))}
        </div>
      </div>

      {state.error && <div className="flash flash-error mb-3">{state.error}</div>}

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? 'Generando…' : 'Generar key'}
      </button>
    </form>
  )
}
