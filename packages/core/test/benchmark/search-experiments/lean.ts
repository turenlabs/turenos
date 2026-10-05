import { Interned } from "./interned"

export function transform(source: string) {
  const marker = "text: `${name} ${name} ${kind} ${file} ${body}`,"
  if (!source.includes(marker)) throw new Error("Missing generic symbol text marker")
  return Interned.transform(source).replace(
    marker,
    'text: `${name} ${name} ${kind} ${kind === "value" ? lines[i]! : `${file} ${body}`}`,',
  )
}
