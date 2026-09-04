'use client'

import { BellIcon, CheckIcon, CopyIcon, KeyIcon } from '@primer/octicons-react'
import { useActionState, useEffect, useState } from 'react'

import type { ApiKeyListItem } from '@/lib/data/api-keys'

import { consumeRevealedKeyAction, deleteApiKeyAction } from './actions'
import { EMPTY_STATE } from './state'

/** Port of one row of github.com/settings/personal-access-tokens: an icon, a
 * title, a muted metadata line, and one action on the right. That page's
 * avatar is the resource owner's — meaningless here, since a key has no
 * single target — so it is the roster's `.assignment-icon` circle instead. */
export function ApiKeyRow({
  apiKey,
  revealedKey,
}: {
  apiKey: ApiKeyListItem
  /** The raw value, right after this key was created. Shown once — see actions.ts */
  revealedKey: string | null
}) {
  const [, deleteAction, deleting] = useActionState(deleteApiKeyAction, EMPTY_STATE)

  // Frozen on mount, not read from the `revealedKey` prop on every render:
  // consuming the cookie below makes Next.js refresh this route, which would
  // hand this component `revealedKey: null` on the very next render — and the
  // banner would vanish before the user had a chance to copy anything. A
  // *reload* is what should stop showing it, not this same client session.
  const [shownKey] = useState(revealedKey)

  useEffect(() => {
    if (revealedKey) void consumeRevealedKeyAction()
  }, [revealedKey])

  return (
    <div className="Box-row">
      <div className="d-flex flex-items-center flex-justify-between">
        <div className="d-flex flex-items-center">
          <span className="assignment-icon assignment-icon-individual d-inline-flex flex-items-center flex-justify-center flex-shrink-0">
            <KeyIcon size={20} />
          </span>
          <div>
            <h3 className="h5 mb-0">{apiKey.label}</h3>
            <p className="text-small color-fg-muted mb-0">
              {apiKey.scopes.join(', ')} · creada el {apiKey.createdAt.toLocaleDateString('es-AR')}
            </p>
          </div>
        </div>

        <form action={deleteAction}>
          <input type="hidden" name="key_id" value={apiKey.id} />
          <button
            type="submit"
            className="btn btn-sm btn-danger"
            disabled={deleting}
            onClick={(event) => {
              if (!window.confirm(`¿Borrar "${apiKey.label}"? No se puede deshacer.`)) {
                event.preventDefault()
              }
            }}
          >
            Borrar
          </button>
        </form>
      </div>

      {shownKey && (
        <div className="flash flash-success mt-3 d-flex">
          <BellIcon size={16} className="mr-2 flex-shrink-0" />
          <div className="flex-auto">
            <strong>Guardá esta key ahora — no se va a volver a mostrar.</strong>
            <div className="input-group mt-2">
              <input
                type="text"
                readOnly
                value={shownKey}
                aria-label="API key"
                className="form-control color-bg-inset text-mono text-small"
              />
              <span className="input-group-button">
                <CopyButton value={shownKey} />
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      className="btn"
      aria-label="Copiar key"
      onClick={() => {
        void navigator.clipboard.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }}
    >
      {copied ? <CheckIcon className="color-fg-success" /> : <CopyIcon />}
    </button>
  )
}
