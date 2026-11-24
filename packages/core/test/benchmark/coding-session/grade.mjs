import assert from "node:assert/strict"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const [directory, stage] = process.argv.slice(2)
const { shippingCents } = await import(pathToFileURL(join(directory, "cart.mjs")).href)
const line = (unitCents, quantity = 1) => ({ unitCents, quantity })

assert.equal(shippingCents([line(2500, 2)]), 0, "quantity and inclusive threshold")
assert.equal(shippingCents([line(5000)]), 0, "single item at the threshold")
assert.equal(shippingCents([line(1200, 3), line(799, 2)]), 0, "multiple quantities above the threshold")
assert.equal(shippingCents([line(1200, 3), line(1399)]), 499, "one cent below the threshold")
assert.equal(shippingCents([]), 499, "empty cart")
assert.equal(shippingCents([line(5000, 4)], "express"), 1199, "express never becomes free")
assert.throws(() => shippingCents([], "unknown"), RangeError)

if (stage === "2") {
  assert.equal(shippingCents([line(3000, 2)], "standard", 1000), 0, "discount leaves exactly the threshold")
  assert.equal(shippingCents([line(3000, 2)], "standard", 1001), 499, "discount lowers subtotal beneath the threshold")
  assert.equal(shippingCents([line(7000)], undefined, 0), 0, "zero discount and implicit method")
  assert.equal(shippingCents([line(2000, 3)], undefined, 8000), 499, "discount greater than subtotal")
  assert.equal(shippingCents([line(9500)], "express", 9500), 1199, "discount does not change express pricing")
}
