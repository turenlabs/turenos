import { describe, expect, test } from "bun:test"

for (const version of ["legacy", "v2"] as const) {
  const params = await (version === "legacy"
    ? import("../src/gen/core/params.gen")
    : import("../src/v2/gen/core/params.gen"))
  const transport = await (version === "legacy"
    ? import("../src/gen/client/client.gen")
    : import("../src/v2/gen/client/client.gen"))

  describe(`${version} generated transport`, () => {
    test("serializes prototype-named fields as own data without changing the slot prototype", () => {
      const result = params.buildClientParams(
        [JSON.parse('{"__proto__":{"injected":true},"constructor":"value"}')],
        [{ allowExtra: { body: true } }],
      )
      expect(Object.getPrototypeOf(result.body)).toBeNull()
      expect(Object.hasOwn(result.body as object, "__proto__")).toBe(true)
      expect(JSON.stringify(result.body)).toBe('{"__proto__":{"injected":true},"constructor":"value"}')
    })

    test("retains an explicitly supplied empty array body", () => {
      expect(params.buildClientParams([[]], [{ in: "body" }]).body).toEqual([])
    })

    test("reports transport failures without pretending an HTTP response exists", async () => {
      const client = transport.createClient({ baseUrl: "http://127.0.0.1:1" })
      const controller = new AbortController()
      const error = new Error("cancelled SDK request")
      controller.abort(error)
      const result = await client.get({ url: "/probe", signal: controller.signal })
      expect(result.error).toBe(error)
      expect(result.response).toBeUndefined()
      await expect(client.get({ url: "/probe", signal: controller.signal, throwOnError: true })).rejects.toBe(error)
    })
  })
}
