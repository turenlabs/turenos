export * as BoundedJson from "./bounded-json"

/** Preflight the expanded JSON tree before serialization; shared DAGs also consume the budget. */
export function encode(value: unknown, maxBytes: number, maxNodes = 100_000): string | undefined {
  const pending = [{ value, depth: 0 }]
  let bytes = 0
  let nodes = 0
  while (pending.length > 0) {
    const item = pending.pop()!
    if (++nodes > maxNodes || item.depth > 100) return
    if (item.value === null || typeof item.value === "boolean") bytes += 5
    else if (typeof item.value === "number") {
      if (!Number.isFinite(item.value)) return
      bytes += String(item.value).length
    } else if (typeof item.value === "string") {
      if (item.value.length > maxBytes) return
      bytes += stringBytes(item.value)
    } else if (typeof item.value === "object") {
      if (Object.getOwnPropertyDescriptor(item.value, "toJSON")) return
      if (Array.isArray(item.value)) {
        if (Object.getPrototypeOf(item.value) !== Array.prototype) return
        if (item.value.length > maxNodes - nodes - pending.length) return
        bytes += 2 + item.value.length
        for (let index = 0; index < item.value.length; index++) {
          const field = Object.getOwnPropertyDescriptor(item.value, String(index))
          if (field && !("value" in field)) return
          pending.push({ value: field?.value ?? null, depth: item.depth + 1 })
        }
      } else {
        const prototype = Object.getPrototypeOf(item.value)
        if (prototype !== Object.prototype && prototype !== null) return
        bytes += 2
        for (const key in item.value) {
          if (!Object.hasOwn(item.value, key)) continue
          const field = Object.getOwnPropertyDescriptor(item.value, key)
          if (!field || !("value" in field)) return
          if (field.value === undefined) continue
          if (pending.length + nodes >= maxNodes || key.length > maxBytes) return
          bytes += stringBytes(key) + 2
          pending.push({ value: field.value, depth: item.depth + 1 })
          if (bytes > maxBytes) return
        }
      }
    } else return
    if (bytes > maxBytes) return
  }
  const encoded = JSON.stringify(value)
  return typeof encoded === "string" && Buffer.byteLength(encoded) <= maxBytes ? encoded : undefined
}

function stringBytes(value: string) {
  let bytes = 2
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) bytes += 2
    else if (code < 32) bytes += 6
    else if (code < 128) bytes++
    else if (code < 2048) bytes += 2
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4
      index++
    } else if (code >= 0xd800 && code <= 0xdfff) bytes += 6
    else bytes += 3
  }
  return bytes
}
