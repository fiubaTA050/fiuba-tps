import type { ReactElement } from 'react'

/**
 * Plain text with its line breaks kept and its http(s) URLs clickable — the
 * devolución's format. No Markdown: a GitHub permalink to the lines at the
 * SHA (`blob/<sha>/raft.go#L88-L102`) is what points at code, and that only
 * needs the link.
 */
export function LinkifiedText({ text, className }: { text: string; className?: string }) {
  return (
    <p className={className} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {linkify(text)}
    </p>
  )
}

const URL_PATTERN = /https?:\/\/[^\s<>"]+/g

// Punctuation that closes the sentence a URL sits in, rather than the URL
const TRAILING = /[.,;:!?)\]]+$/

function linkify(text: string) {
  const parts: (string | ReactElement)[] = []
  let last = 0

  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRAILING, '')
    const start = match.index
    parts.push(text.slice(last, start))
    parts.push(
      <a key={start} href={url} target="_blank" rel="noreferrer">
        {url}
      </a>,
    )
    last = start + url.length
  }

  parts.push(text.slice(last))
  return parts
}
