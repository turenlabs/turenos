/** A local date and time that never breaks across lines or follows the viewer's locale: 2026-10-04 12:53. */
export function stamp(ms: number) {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return "unknown"
  const two = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}
