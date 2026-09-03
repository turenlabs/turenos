export function titlecase(value: string) {
  return value.replace(/\b\w/g, (character) => character.toUpperCase())
}

export function time(input: number): string {
  return new Date(input).toLocaleTimeString(undefined, { timeStyle: "short" })
}

export function datetime(input: number): string {
  const date = new Date(input)
  return `${time(input)} · ${date.toLocaleDateString()}`
}

export function todayTimeOrDateTime(input: number): string {
  const date = new Date(input)
  const now = new Date()
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return time(input)
  }
  return datetime(input)
}

export function number(value: number): string {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + "M"
  if (value >= 1_000) return (value / 1_000).toFixed(1) + "K"
  return value.toString()
}

export function duration(input: number) {
  if (input < 1_000) return `${input}ms`
  if (input < 60_000) return `${(input / 1_000).toFixed(1)}s`
  if (input < 3_600_000) {
    return `${Math.floor(input / 60_000)}m ${Math.floor((input % 60_000) / 1_000)}s`
  }
  if (input < 86_400_000) {
    return `${Math.floor(input / 3_600_000)}h ${Math.floor((input % 3_600_000) / 60_000)}m`
  }
  return `${Math.floor(input / 86_400_000)}d ${Math.floor((input % 86_400_000) / 3_600_000)}h`
}

export function truncate(value: string, length: number): string {
  if (value.length <= length) return value
  return value.slice(0, length - 1) + "…"
}

export function truncateLeft(value: string, length: number): string {
  if (value.length <= length) return value
  return "…" + value.slice(-(length - 1))
}

export function truncateMiddle(value: string, maxLength = 35): string {
  if (value.length <= maxLength) return value
  const start = Math.ceil((maxLength - 1) / 2)
  const end = Math.floor((maxLength - 1) / 2)
  return value.slice(0, start) + "…" + value.slice(-end)
}

export function pluralize(count: number, singular: string, plural: string): string {
  return (count === 1 ? singular : plural).replace("{}", count.toString())
}

export * as Locale from "./locale"
