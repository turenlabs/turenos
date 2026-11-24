import { rates } from "./rates.mjs"

export function shippingCents(items, method = "standard") {
  const rate = rates[method]
  if (!rate) throw new RangeError(`Unknown shipping method: ${method}`)
  const subtotal = items.reduce((total, item) => total + item.unitCents, 0)
  return subtotal > rate.freeAt ? 0 : rate.fee
}
