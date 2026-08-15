'use client'

import { useId, useRef } from 'react'

/**
 * The "one identifier per line" textarea with its file picker, shared by the
 * create-roster form and the add-students form exactly as the original shared
 * it between `rosters/new.html.erb` and `_new_student_modal.html.erb`.
 *
 * Controlled from the parent, which is what lets the add-students form empty
 * it once the students are in.
 *
 * Port of identifier.js, which read the file and appended it to the textarea.
 * Divergence: it appended with no separator, so uploading a file on top of
 * anything already typed glued the last typed identifier to the file's first
 * one. Here the newline is added when it is missing.
 */
export function IdentifiersField({
  label,
  identifierName,
  value,
  onChange,
}: {
  label: string
  identifierName: string
  value: string
  onChange: (value: string) => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const textareaId = useId()
  const fileId = useId()

  async function onFileChange(file: File | undefined) {
    if (!file) return

    const text = await file.text()
    onChange(value.length === 0 || value.endsWith('\n') ? value + text : `${value}\n${text}`)

    // Let the same file be picked again after clearing the textarea
    if (fileInput.current) fileInput.current.value = ''
  }

  return (
    <div className="Box">
      <div className="Box-body">
        <label htmlFor={textareaId} className="d-block color-fg-muted mb-1">
          {label}
        </label>
        <textarea
          id={textareaId}
          name="identifiers"
          rows={10}
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="form-control input-block input-monospace"
          placeholder={'107254\n104512\n98765'}
          aria-describedby={`${textareaId}-note`}
        />
        <p id={`${textareaId}-note`} className="note">
          Un {identifierName.toLowerCase()} por línea.
        </p>
      </div>

      <div className="Box-footer">
        <label className="btn btn-sm" htmlFor={fileId}>
          Subir un CSV o un archivo de texto
        </label>
        <input
          id={fileId}
          ref={fileInput}
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          className="d-none"
          onChange={(event) => onFileChange(event.target.files?.[0])}
        />
      </div>
    </div>
  )
}
