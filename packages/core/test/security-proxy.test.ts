import { describe, expect, test } from "bun:test"
import { Database } from "@turenlabs/core/database/database"
import { SecurityProxyStore } from "@turenlabs/core/security-proxy"
import { SecretVault } from "@turenlabs/core/secret-vault"
import { Storage } from "@turenlabs/core/storage"
import { StorageStateTable } from "@turenlabs/core/storage/sql"
import { SecurityProxy } from "@turenlabs/schema/security-proxy"
import { Effect, Exit, Layer, Schema } from "effect"
import { tmpdir } from "./fixture/tmpdir"

const owner: SecurityProxy.Owner = { directory: "/proxy/project", workspaceID: "workspace_a" }
const other: SecurityProxy.Owner = { ...owner, workspaceID: "workspace_b" }
const input: SecurityProxy.Create = { id: "case_a", name: "Authorized target" }
const body: SecurityProxy.Body = { data: "", encoding: "utf8", state: "complete", size: 0 }
const flow: SecurityProxy.Flow = {
  id: "flow_a",
  caseID: input.id,
  source: "browser",
  state: "complete",
  createdAt: 123,
  request: {
    url: "https://example.test/api?token=url-secret",
    method: "POST",
    headers: [{ name: "Authorization", value: "Bearer header-secret" }],
    body: { ...body, data: '{"password":"body-secret"}', size: 26 },
  },
  responseHeaders: [{ name: "Set-Cookie", value: "session=cookie-secret" }],
  responseBody: body,
  status: 200,
  note: "note-secret",
}

function fixture(path: string) {
  const database = Database.layerFromPath(`${path}/proxy.db`)
  const storage = Storage.layer.pipe(Layer.provide(database))
  const vault = SecretVault.layer({ keyID: "proxy-test", key: new Uint8Array(32).fill(17) })
  const dependencies = Layer.mergeAll(database, storage, vault)
  const layer = Layer.merge(dependencies, SecurityProxyStore.layer.pipe(Layer.provide(dependencies)))
  // Each run builds/closes a fresh graph against the same file and key, exercising restart durability.
  const run = <A, E>(
    effect: Effect.Effect<A, E, SecurityProxyStore.Service | Storage.Service | Database.Service | SecretVault.Service>,
  ) => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped))
  const execute = (command: SecurityProxy.StoreCommand) =>
    run(SecurityProxyStore.Service.use((store) => store.execute(command)))
  const fails = (command: SecurityProxy.StoreCommand) =>
    run(SecurityProxyStore.Service.use((store) => Effect.exit(store.execute(command)))).then(Exit.isFailure)
  const rows = () => run(Database.Service.use((database) => database.db.select().from(StorageStateTable).all()))
  return { run, execute, fails, rows }
}

const owned = { owner, caseID: input.id }

describe("durable security proxy storage", () => {
  test("shares bounded flow pagination fields across command schemas", () => {
    const command = {
      type: "flows",
      ...owned,
      cursor: { key: "data/case_a/flow/flow_a", timeCreated: 777 },
      filter: {
        query: "api",
        content: true,
        method: "POST",
        mime: "json",
        host: "example.test",
        status: "200",
        source: "browser",
      },
      view: "masked",
    }
    for (const decode of [
      Schema.decodeUnknownSync(SecurityProxy.Command),
      Schema.decodeUnknownSync(SecurityProxy.StoreCommand),
    ]) {
      expect(decode(command)).toMatchObject(command)
      expect(() => decode({ ...command, cursor: { key: "x".repeat(4097), timeCreated: 1 } })).toThrow()
      expect(() => decode({ ...command, filter: { query: "x".repeat(4097) } })).toThrow()
      expect(() => decode({ ...command, view: "unmasked" })).toThrow()
    }
  })

  test("validates creates, reconciles exact input, and isolates full owners", async () => {
    await using tmp = await tmpdir()
    const store = fixture(tmp.path)
    expect(await store.fails({ type: "create", owner, input: { ...input, name: " " } })).toBe(true)
    const first = await store.execute({ type: "create", owner, input })
    expect(first.created).toBe(true)
    expect(first.case).toMatchObject({ ...input, owner, revision: 1, rules: [] })
    expect(await store.execute({ type: "create", owner, input })).toEqual({ ...first, created: false })
    expect(await store.fails({ type: "create", owner, input: { ...input, name: "changed" } })).toBe(true)
    expect(await store.execute({ type: "list", owner: other })).toEqual({ cases: [] })
    expect(await store.fails({ type: "get", ...owned, owner: other })).toBe(true)
    expect(await store.fails({ type: "delete", ...owned, owner: other })).toBe(true)
    expect(
      await store.fails({
        type: "get",
        ...owned,
        owner: { directory: "/another/project", workspaceID: owner.workspaceID },
      }),
    ).toBe(true)
    expect(await store.fails({ type: "get", ...owned, caseID: "missing" })).toBe(true)
    expect((await store.execute({ type: "create", owner: other, input })).created).toBe(true)
    const listed = JSON.stringify(await store.execute({ type: "list", owner }))
    expect(listed).toContain("Authorized target")
  })

  test("seals multi-chunk UTF-8 originals, masks reads, and survives reopened layers", async () => {
    await using tmp = await tmpdir()
    const store = fixture(tmp.path)
    await store.execute({ type: "create", owner, input })
    const large: SecurityProxy.Flow = {
      ...flow,
      responseBody: { ...body, data: "€".repeat(350_000), size: 1_050_000 },
      originalRequest: flow.request,
      originalResponse: {
        status: 201,
        headers: flow.responseHeaders,
        body: { ...body, data: "original-response-secret", size: 24 },
      },
    }
    expect((await store.execute({ type: "put", ...owned, flow: large })).created).toBe(true)
    expect((await store.execute({ type: "put", ...owned, flow: large })).created).toBe(false)
    expect(await store.fails({ type: "put", ...owned, flow: { ...large, status: 500 } })).toBe(true)
    expect(
      await store.fails({
        type: "put",
        ...owned,
        flow: { ...large, request: { ...large.request, body: { ...body, data: "changed" } } },
      }),
    ).toBe(true)
    expect(await store.fails({ type: "reveal", ...owned, owner: other, flowID: flow.id })).toBe(true)
    expect((await fixture(tmp.path).execute({ type: "reveal", ...owned, flowID: flow.id })).flow).toEqual(large)
    const masked = (await store.execute({ type: "flow", ...owned, flowID: flow.id })).flow!
    expect(masked.responseBody.data.length).toBeLessThanOrEqual(65536)
    expect(masked.responseBody.state).toBe("truncated")
    expect(masked.request.headers[0]!.value).toBe("[REDACTED]")
    expect(masked.request.url).not.toContain("url-secret")
    expect(masked.request.body.data).not.toContain("body-secret")
    expect(masked.note).not.toContain("note-secret")
    const summary = (await store.execute({ type: "flows", ...owned })).flows![0]!
    expect(summary.id).toBe(masked.id)
    expect(summary.request.url).toBe(masked.request.url)
    expect(summary.request.body.data).toBe("")
    expect(summary.responseBody.data).toBe("")
    expect(summary.responseBody.state).toBe("unavailable")
    expect(summary.request.headers).toEqual([])
    expect(summary.responseHeaders).toEqual([])
    expect(summary.originalRequest).toBeUndefined()
    expect(summary.originalResponse).toBeUndefined()
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(1024)
    const rows = await store.rows()
    expect(rows.filter((row) => row.key.includes("/chunk/")).length).toBeGreaterThan(1)
    expect(rows.every((row) => row.value.startsWith("forge-secret:v1:"))).toBe(true)
    expect(JSON.stringify(rows)).not.toContain('secret"')
    for (const secret of [
      "url-secret",
      "header-secret",
      "body-secret",
      "cookie-secret",
      "note-secret",
      "original-response-secret",
      "€€€",
    ])
      expect(JSON.stringify(rows)).not.toContain(secret)
    const disk = Buffer.from(await Bun.file(`${tmp.path}/proxy.db`).arrayBuffer()).toString("utf8")
    expect(disk).not.toContain("header-secret")
    expect(disk).not.toContain("original-response-secret")
    // A listing must not touch payload chunks, even for a multi-chunk flow.
    await store.run(
      Storage.Service.use((storage) =>
        storage.batch({
          sets: [],
          removes: rows.filter((row) => row.key.includes("/chunk/")).map((row) => ({ scope: row.scope, key: row.key })),
        }),
      ),
    )
    expect((await store.execute({ type: "flows", ...owned })).flows).toEqual([summary])
    expect(await store.fails({ type: "flow", ...owned, flowID: flow.id })).toBe(true)
    expect(await store.fails({ type: "reveal", ...owned, flowID: flow.id })).toBe(true)
  })

  test("reserves replay once and permits exactly one unknown-to-terminal transition", async () => {
    await using tmp = await tmpdir()
    const store = fixture(tmp.path)
    await store.execute({ type: "create", owner, input })
    const replay: SecurityProxy.Flow = {
      ...flow,
      id: "replay_a",
      source: "replay",
      state: "unknown",
      parentID: flow.id,
      status: undefined,
    }
    expect((await store.execute({ type: "reserve", ...owned, flow: replay })).created).toBe(true)
    expect((await fixture(tmp.path).execute({ type: "reserve", ...owned, flow: replay })).created).toBe(false)
    const retried = await store.execute({
      type: "reserve",
      ...owned,
      flow: { ...replay, createdAt: replay.createdAt + 10_000 },
    })
    expect(retried.created).toBe(false)
    expect(retried.flow!.createdAt).toBe(replay.createdAt)
    expect(
      await store.fails({
        type: "reserve",
        ...owned,
        flow: { ...replay, request: { ...replay.request, method: "DELETE" } },
      }),
    ).toBe(true)
    expect(
      await store.fails({
        type: "reserve",
        ...owned,
        flow: { ...replay, parentID: "different_parent", createdAt: 999 },
      }),
    ).toBe(true)
    const terminal: SecurityProxy.Flow = { ...replay, state: "complete", status: 204 }
    await store.execute({ type: "put", ...owned, flow: terminal })
    expect((await store.execute({ type: "put", ...owned, flow: terminal })).created).toBe(false)
    expect((await store.execute({ type: "reserve", ...owned, flow: replay })).created).toBe(false)
    expect((await store.execute({ type: "reserve", ...owned, flow: { ...replay, createdAt: 999 } })).created).toBe(
      false,
    )
    expect(await store.fails({ type: "put", ...owned, flow: { ...terminal, createdAt: 999 } })).toBe(true)
    expect(await store.fails({ type: "put", ...owned, flow: { ...terminal, state: "failed" } })).toBe(true)
    const unreserved: SecurityProxy.Flow = { ...replay, id: "unreserved" }
    await store.execute({ type: "put", ...owned, flow: unreserved })
    expect(await store.fails({ type: "put", ...owned, flow: { ...unreserved, state: "complete" } })).toBe(true)
  })

  test("CAS rules and encrypted notes preserve originals; delete clears only the owned case", async () => {
    await using tmp = await tmpdir()
    const store = fixture(tmp.path)
    await store.execute({ type: "create", owner, input })
    await store.execute({ type: "create", owner: other, input })
    const rule: SecurityProxy.Rule = {
      id: "rule_a",
      enabled: true,
      stage: "request",
      path: "/api",
      method: "POST",
      action: "replace",
      find: "before",
      replace: "rule-secret",
    }
    const updated = await store.execute({ type: "rules", ...owned, revision: 1, rules: [rule] })
    expect(updated.case!.revision).toBe(2)
    expect(await store.fails({ type: "rules", ...owned, revision: 1, rules: [] })).toBe(true)
    await store.execute({ type: "put", ...owned, flow })
    const before = (await store.execute({ type: "get", ...owned })).case!
    expect(before.revision).toBe(updated.case!.revision)
    await store.execute({ type: "note", ...owned, flowID: flow.id, note: "new-note-secret" })
    expect((await store.execute({ type: "reveal", ...owned, flowID: flow.id })).flow).toEqual({
      ...flow,
      note: "new-note-secret",
    })
    expect((await store.execute({ type: "get", ...owned })).case!.revision).toBe(before.revision)
    expect((await store.execute({ type: "put", ...owned, flow })).created).toBe(false)
    expect((await store.execute({ type: "reveal", ...owned, flowID: flow.id })).flow!.note).toBe("new-note-secret")
    expect(JSON.stringify(await store.rows())).not.toContain("new-note-secret")
    expect(
      (await store.execute({ type: "rules", ...owned, revision: updated.case!.revision, rules: [] })).case!.revision,
    ).toBe(3)
    await store.execute({ type: "delete", ...owned })
    expect(await store.fails({ type: "reveal", ...owned, flowID: flow.id })).toBe(true)
    expect(await store.execute({ type: "list", owner })).toEqual({ cases: [] })
    expect((await store.execute({ type: "get", ...owned, owner: other })).case!.id).toBe(input.id)
    const rows = await store.rows()
    expect(rows.filter((row) => row.deleted).every((row) => row.value === "")).toBe(true)
    expect(rows.filter((row) => !row.deleted)).toHaveLength(1)
  })

  test("bounds flow listings and deletes more than one storage page", async () => {
    await using tmp = await tmpdir()
    const store = fixture(tmp.path)
    await store.run(
      Effect.gen(function* () {
        const service = yield* SecurityProxyStore.Service
        yield* service.execute({ type: "create", owner, input })
        for (let index = 0; index < 205; index++) {
          yield* service.execute({
            type: "put",
            ...owned,
            flow: {
              ...flow,
              id: `flow_${String(index).padStart(4, "0")}`,
              request: { ...flow.request, method: index < 5 ? "PATCH" : "POST" },
            },
          })
        }
        const database = yield* Database.Service
        yield* database.db.update(StorageStateTable).set({ time_created: 777 }).run()
        const listed = yield* service.execute({ type: "flows", ...owned })
        expect(listed.flows).toHaveLength(200)
        expect(listed.total).toBe(205)
        expect(listed.nextCursor).toEqual({ key: "data/case_a/flow/flow_0005", timeCreated: 777 })
        expect(listed.flows![0]!.id).toBe("flow_0204")
        expect(listed.flows!.at(-1)!.id).toBe("flow_0005")
        const older = yield* service.execute({ type: "flows", ...owned, cursor: listed.nextCursor })
        expect(older.flows).toHaveLength(5)
        expect(older.nextCursor).toBeUndefined()
        expect(new Set([...listed.flows!, ...older.flows!].map((item) => item.id)).size).toBe(205)
        const filtered = yield* service.execute({ type: "flows", ...owned, filter: { method: "patch" } })
        expect(filtered.flows).toEqual([])
        expect(filtered.nextCursor).toEqual(listed.nextCursor)
        const matches = yield* service.execute({
          type: "flows",
          ...owned,
          filter: { method: "patch" },
          cursor: filtered.nextCursor,
        })
        expect(matches.flows).toHaveLength(5)
        expect(matches.total).toBe(205)
        const invalid = yield* Effect.exit(
          service.execute({
            type: "flows",
            ...owned,
            cursor: { key: "data/other_case/flow/flow_a", timeCreated: 777 },
          }),
        )
        expect(Exit.isFailure(invalid)).toBe(true)
        yield* service.execute({ type: "delete", ...owned })
      }),
    )
    expect((await store.rows()).every((row) => row.deleted && row.value === "")).toBe(true)
  }, 30_000)

  test("keeps MIME compact and searches only masked content with bounded export pages", async () => {
    await using tmp = await tmpdir()
    const store = fixture(tmp.path)
    await store.run(
      Effect.gen(function* () {
        const service = yield* SecurityProxyStore.Service
        yield* service.execute({ type: "create", owner, input })
        const captured: SecurityProxy.Flow = {
          ...flow,
          responseHeaders: [
            ...flow.responseHeaders,
            { name: "cOnTeNt-TyPe", value: "Application/JSON; charset=utf-8; boundary=parameter-secret" },
            { name: "X-Public", value: "public-header" },
          ],
          responseBody: { ...body, data: '{"message":"public-body","token":"response-secret"}', size: 51 },
          originalRequest: flow.request,
        }
        for (let index = 0; index < 12; index++) {
          yield* service.execute({ type: "put", ...owned, flow: { ...captured, id: `export_${index}` } })
        }
        const summary = yield* service.execute({ type: "flows", ...owned })
        expect(summary.flows).toHaveLength(12)
        expect(summary.flows![0]!.responseHeaders).toEqual([{ name: "Content-Type", value: "application/json" }])
        expect(JSON.stringify(summary)).not.toContain("parameter-secret")
        expect(Buffer.byteLength(JSON.stringify(summary.flows![0]))).toBeLessThan(1024)
        for (const filter of [
          { method: "post", status: "20", mime: "JSON", host: "EXAMPLE.TEST", source: "browser" as const },
          { status: "COMPLETE" },
          { query: "public-header", content: true },
          { query: "public-body", content: true },
          { query: "export_" },
        ]) {
          expect((yield* service.execute({ type: "flows", ...owned, filter })).flows).toHaveLength(12)
        }
        for (const query of [
          "url-secret",
          "header-secret",
          "body-secret",
          "cookie-secret",
          "note-secret",
          "response-secret",
        ]) {
          for (const view of ["summary", "revealed"] as const) {
            const result = yield* service.execute({ type: "flows", ...owned, view, filter: { query, content: true } })
            expect(result.flows).toEqual([])
            if (view === "revealed") expect(result.nextCursor).toBeDefined()
          }
        }
        expect((yield* service.execute({ type: "flows", ...owned, filter: { query: "public-body" } })).flows).toEqual(
          [],
        )
        expect((yield* service.execute({ type: "flows", ...owned, filter: { host: "test" } })).flows).toEqual([])
        expect((yield* service.execute({ type: "flows", ...owned, filter: { source: "replay" } })).flows).toEqual([])
        const masked = yield* service.execute({ type: "flows", ...owned, view: "masked" })
        expect(masked.flows).toHaveLength(10)
        expect(masked.flows![0]!.request.headers[0]!.value).toBe("[REDACTED]")
        expect(masked.flows![0]!.responseBody.data).toContain("public-body")
        expect(masked.flows![0]!.originalRequest).toBeDefined()
        expect(masked.flows![0]!.note).toBe("[REDACTED]")
        const tail = yield* service.execute({ type: "flows", ...owned, view: "masked", cursor: masked.nextCursor })
        expect(tail.flows).toHaveLength(2)
        expect(tail.nextCursor).toBeUndefined()
        const revealed = yield* service.execute({ type: "flows", ...owned, view: "revealed" })
        expect(revealed.flows).toHaveLength(1)
        expect(revealed.flows![0]!.request).toEqual(captured.request)
        expect(revealed.flows![0]!.responseBody).toEqual(captured.responseBody)
        expect(revealed.flows![0]!.note).toBe(captured.note)
        expect(revealed.nextCursor).toBeDefined()
        expect(
          Exit.isFailure(
            yield* Effect.exit(service.execute({ type: "flows", ...owned, owner: other, view: "revealed" })),
          ),
        ).toBe(true)
      }),
    )
  })

  test("hydrates persisted legacy summaries without exposing headers or body data", async () => {
    await using tmp = await tmpdir()
    const store = fixture(tmp.path)
    await store.execute({ type: "create", owner, input })
    await store.execute({
      type: "put",
      ...owned,
      flow: {
        ...flow,
        responseHeaders: [...flow.responseHeaders, { name: "Content-Type", value: "Text/HTML; charset=utf-8" }],
      },
    })
    await store.run(
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const vault = yield* SecretVault.Service
        const rows = yield* Database.Service.use((database) => database.db.select().from(StorageStateTable).all())
        const row = rows.find((row) => row.key.includes("/flow/"))!
        const manifest = Schema.decodeUnknownSync(Schema.Struct({ summary: SecurityProxy.Flow }), {
          onExcessProperty: "preserve",
        })(JSON.parse(yield* vault.open(row.scope, row.key, row.value)))
        const legacy = { ...manifest, summaryVersion: undefined, summary: { ...manifest.summary, responseHeaders: [] } }
        yield* storage.set({
          scope: row.scope,
          key: row.key,
          value: yield* vault.seal(row.scope, row.key, JSON.stringify(legacy)),
        })
      }),
    )
    const listed = await fixture(tmp.path).execute({ type: "flows", ...owned, filter: { mime: "html" } })
    expect(listed.flows).toHaveLength(1)
    expect(listed.flows![0]!.responseHeaders).toEqual([{ name: "Content-Type", value: "text/html" }])
    expect(listed.flows![0]!.request.headers).toEqual([])
    expect(listed.flows![0]!.request.body.data).toBe("")
    expect(JSON.stringify(listed)).not.toContain("cookie-secret")
  })

  test("separate service instances reconcile concurrent creates using persisted guards", async () => {
    await using tmp = await tmpdir()
    const store = fixture(tmp.path)
    await store.run(
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const vault = yield* SecretVault.Service
        const dependencies = Layer.merge(
          Layer.succeed(Storage.Service, storage),
          Layer.succeed(SecretVault.Service, vault),
        )
        const first = yield* SecurityProxyStore.Service.pipe(
          Effect.provide(SecurityProxyStore.layer.pipe(Layer.provide(dependencies))),
        )
        const second = yield* SecurityProxyStore.Service.pipe(
          Effect.provide(SecurityProxyStore.layer.pipe(Layer.provide(dependencies))),
        )
        const results = yield* Effect.all(
          [first.execute({ type: "create", owner, input }), second.execute({ type: "create", owner, input })],
          { concurrency: 2 },
        )
        expect(results.filter((result) => result.created)).toHaveLength(1)
        expect(results[0]!.case).toEqual(results[1]!.case)
        const revisions = yield* Effect.all(
          [
            Effect.exit(first.execute({ type: "rules", ...owned, revision: 1, rules: [] })),
            Effect.exit(second.execute({ type: "rules", ...owned, revision: 1, rules: [] })),
          ],
          { concurrency: 2 },
        )
        expect(revisions.filter(Exit.isSuccess)).toHaveLength(1)
      }),
    )
  })
})
