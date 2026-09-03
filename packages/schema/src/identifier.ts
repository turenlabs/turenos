const length = 26
const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let lastTimestamp = 0
let counter = 0

export function ascending() {
  return create(false)
}

export function descending() {
  return create(true)
}

export function create(descending: boolean, timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++

  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
  let id = BigInt.asUintN(48, descending ? ~current : current)
    .toString(16)
    .padStart(12, "0")
  const bytes = crypto.getRandomValues(new Uint8Array(length - 12))
  for (const byte of bytes) id += chars[byte % chars.length]
  return id
}
