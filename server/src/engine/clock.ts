/**
 * Today's date where the books are kept (the machine's local date, as Tally reads it), which a
 * test can set. Post-dated vouchers wait for it.
 */
let fixed: string | null = null

export function today(): string {
  if (fixed) return fixed
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

/** For tests: pretend it is this date (null: the real one again). */
export function setToday(date: string | null) {
  fixed = date
}
