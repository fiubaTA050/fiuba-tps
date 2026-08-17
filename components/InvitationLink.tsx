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
 *
 * The live site uses both shapes: the field on an assignment's own page, and a
 * plain "Copy invite link" button on the classroom's assignment list, where the
 * URL itself would crowd the row. `variant` picks between them; the clipboard
 * handling is the same either way.
 */
export function InvitationLink({
  url,
  disabled = false,
  width,
  variant = 'field',
  className,
}: {
  url: string
  disabled?: boolean
  /**
   * Sizes the field itself, the way the live site does — `width: 43ch` inline
   * on the input, capped at `70vw` by `.js-copy-invitation-link`. Left unset
   * where the link shares a row with other things and has to flex.
   */
  width?: string
  variant?: 'field' | 'button'
  /** Only for the button variant, which sits inline in a row of actions */
  className?: string
}) {
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

  if (variant === 'button') {
    return (
      <button
        type="button"
        onClick={copy}
        disabled={disabled}
        className={`btn ${className ?? ''}`}
        aria-label={`Link de invitación: ${url}`}
      >
        {copied ? (
          <CheckIcon className="color-fg-success mr-2" />
        ) : (
          <CopyIcon className="mr-2 color-fg-muted" />
        )}
        {copied ? 'Copiado' : 'Copiar link de invitación'}
      </button>
    )
  }

  return (
    <div className="input-group">
      <input
        type="text"
        className={`form-control input-sm text-mono ${disabled ? 'color-fg-muted' : ''}`}
        style={width ? { width, maxWidth: '70vw' } : undefined}
        value={url}
        readOnly
        aria-label="Link de invitación"
      />
      <span className="input-group-button">
        <button
          type="button"
          onClick={copy}
          className="btn btn-sm clipboard-input--button"
          aria-label={copied ? 'Copiado' : 'Copiar al portapapeles'}
        >
          {copied ? <CheckIcon className="color-fg-success" /> : <CopyIcon />}
        </button>
      </span>
    </div>
  )
}
