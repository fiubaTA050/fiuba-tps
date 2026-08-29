/**
 * Dates, always read and written in the cátedra's time zone.
 *
 * Nothing here may depend on the clock of the machine it runs on: the server
 * is Vercel, which runs in UTC, and the browser is whatever laptop the teacher
 * opened. A deadline of "11/09 23:59" that renders as 02:59 of the 12th is not
 * a cosmetic bug — it is the difference between on time and late.
 *
 * Argentina has had no DST since 2009 and sits on a fixed −03:00, so parsing
 * with the literal offset is exact and needs no time zone library. Rendering
 * goes through `Intl` with the IANA name, which is the same instant either way
 * and reads better if that ever changes.
 */

export const ARGENTINA_TIME_ZONE = 'America/Argentina/Buenos_Aires'

const ARGENTINA_OFFSET = '-03:00'
const OFFSET_MS = 3 * 60 * 60 * 1000

/** What `<input type="datetime-local">` posts: `2026-09-11T23:59`, no zone */
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/

/**
 * Reads a `datetime-local` field as Argentine local time.
 *
 * Null for anything that is not that shape, which is what an empty field and a
 * hand-crafted POST both look like.
 */
export function parseArgentinaDateTime(value: string): Date | null {
  const trimmed = value.trim()
  if (!LOCAL_DATE_TIME.test(trimmed)) return null

  const withSeconds = trimmed.length === 16 ? `${trimmed}:00` : trimmed
  const parsed = new Date(`${withSeconds}${ARGENTINA_OFFSET}`)

  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * The inverse, to refill the field with what is stored.
 *
 * Shifting by the fixed offset and slicing the ISO string is exact here for the
 * same reason parsing is: there is no DST to get wrong.
 */
export function toArgentinaDateTimeInput(date: Date): string {
  return new Date(date.getTime() - OFFSET_MS).toISOString().slice(0, 16)
}

/** `11 sept 2026 23:59`, the format the rest of the port already shows */
export function formatArgentina(date: Date): string {
  return new Intl.DateTimeFormat('es-AR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: ARGENTINA_TIME_ZONE,
  }).format(date)
}
