export function detectOutputEncoding(chunk: Uint8Array) {
  if (chunk[0] === 0xff && chunk[1] === 0xfe) return "utf-16le"
  const pairs = Math.floor(chunk.length / 2)
  if (pairs < 2) return "utf-8"
  let oddZeroes = 0
  let evenZeroes = 0
  for (let index = 0; index < pairs * 2; index += 2) {
    if (chunk[index] === 0) evenZeroes++
    if (chunk[index + 1] === 0) oddZeroes++
  }
  return oddZeroes >= Math.ceil(pairs / 3) && evenZeroes * 2 <= oddZeroes ? "utf-16le" : "utf-8"
}
