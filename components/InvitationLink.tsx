'use client'

import { CheckIcon, CopyIcon } from '@primer/octicons-react'
import { useEffect, useState } from 'react'

/**
 * Port of shared/invitations/_clipboard_form.html.erb.
 *
 * The original used clipboard.js on a `data-clipboard-target`; the modern
 * Clipboard API does the same without the library. The readonly field stays:
 * it is what lets a teacher on a browser that refuses clipboard access still
 * select the URL by hand.
 */
export function InvitationLink({ url, disabled = false }: { url: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      // Clipboard access denied, or an insecure origin. The field is readonly,
      // not disabled, so selecting the text by hand still works.
    }
  }

  return (
    <div className="input-group">
      <input
        type="text"
        className={`form-control input-sm text-mono ${disabled ? 'color-fg-muted' : ''}`}
        value={url}
        readOnly
        aria-label="Link de invitación"
      />
      <span className="input-group-button">
        <button
          type="button"
          onClick={copy}
          className="btn btn-sm"
          aria-label={copied ? 'Copiado' : 'Copiar al portapapeles'}
        >
          {copied ? <CheckIcon className="color-fg-success" /> : <CopyIcon />}
        </button>
      </span>
    </div>
  )
}
