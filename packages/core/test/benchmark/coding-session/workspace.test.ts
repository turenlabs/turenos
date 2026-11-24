import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { CodingWorkspace } from "./workspace"

const fixed = `import { rates } from './rates.mjs'
export function shippingCents(items, method = 'standard') {
  const rate = rates[method]
  if (!rate) throw new RangeError('unknown method')
  const subtotal = items.reduce((total, item) => total + item.unitCents * item.quantity, 0)
  return subtotal >= rate.freeAt ? 0 : rate.fee
}`

const extended = fixed
  .replace("method = 'standard'", "method = 'standard', discountCents = 0")
  .replace("subtotal >= rate.freeAt", "Math.max(0, subtotal - discountCents) >= rate.freeAt")

test("grades each turn independently and rejects a replaced source path", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "coding-grader-"))
  try {
    await CodingWorkspace.materialize(directory)
    const cart = path.join(directory, "cart.mjs")
    expect(CodingWorkspace.grade(directory, 1)).toBe(false)
    await Bun.write(cart, fixed)
    expect(CodingWorkspace.grade(directory, 1)).toBe(true)
    expect(CodingWorkspace.grade(directory, 2)).toBe(false)
    await Bun.write(cart, extended)
    expect(CodingWorkspace.grade(directory, 2)).toBe(true)
    const rates = path.join(directory, "rates.mjs")
    const original = readFileSync(rates)
    await Bun.write(rates, Buffer.concat([original, Buffer.from("\n// unrelated edit\n")]))
    expect(CodingWorkspace.grade(directory, 2)).toBe(false)
    await Bun.write(rates, original)
    unlinkSync(cart)
    symlinkSync(path.join(import.meta.dir, "fixture", "cart.mjs"), cart)
    expect(CodingWorkspace.grade(directory, 1)).toBe(false)
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
})
