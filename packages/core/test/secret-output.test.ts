import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { Credential } from "@turenlabs/core/credential"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { SecretOutput } from "@turenlabs/core/secret-output"
import { Integration } from "@turenlabs/schema/integration"
import { ExtensionCatalog } from "@turenlabs/extensions"

function providers(all: Credential.Interface["all"], extensions: Partial<ExtensionRuntime.Interface> = {}) {
  const unused = () => Effect.die("Unexpected provider operation")
  return Layer.mergeAll(
    Layer.succeed(
      Credential.Service,
      Credential.Service.of({
        all,
        list: unused,
        get: unused,
        create: unused,
        update: unused,
        remove: unused,
      }),
    ),
    Layer.succeed(
      ExtensionRuntime.Service,
      ExtensionRuntime.Service.of({
        manifests: () => Effect.succeed([]),
        secret: () => Effect.succeed(undefined),
        get: unused,
        desired: unused,
        enabled: unused,
        configuration: unused,
        secretsSet: unused,
        update: unused,
        ...extensions,
      }),
    ),
  )
}

async function snapshot(all: Credential.Interface["all"], extensions: Partial<ExtensionRuntime.Interface> = {}) {
  return Effect.gen(function* () {
    const output = yield* SecretOutput.Service
    return yield* output.snapshot()
  }).pipe(Effect.provide(SecretOutput.layer.pipe(Layer.provide(providers(all, extensions)))), Effect.runPromiseExit)
}

test("reads deduplicated extension declarations even when disabled and covers OAuth tokens", async () => {
  const manifest = ExtensionCatalog.manifests.find((item) =>
    item.contributions.some((part) => part.secrets.length > 0),
  )!
  const calls: string[] = []
  const exit = await snapshot(
    () =>
      Effect.succeed([
        new Credential.Info({
          id: Credential.ID.create(),
          integrationID: Integration.ID.make("oauth"),
          label: "Test",
          value: Credential.OAuth.make({
            type: "oauth",
            access: "opaque.access.12",
            refresh: "opaque.refresh.34",
            expires: 0,
            methodID: Integration.MethodID.make("test"),
          }),
        }),
      ]),
    {
      manifests: () => Effect.succeed([manifest, manifest]),
      enabled: () => Effect.succeed(false),
      secret: (id, name) =>
        Effect.sync(() => {
          calls.push(`${id}:${name}`)
          return "opaque.extension.56"
        }),
    },
  )
  expect(Exit.isSuccess(exit)).toBe(true)
  if (!Exit.isSuccess(exit)) return
  expect(calls.length).toBe(
    new Set(manifest.contributions.flatMap((part) => part.secrets.map((field) => field.id))).size,
  )
  for (const value of ["opaque.access.12", "opaque.refresh.34", "opaque.extension.56"])
    expect(exit.value.text(value)).not.toContain(value)
})

test("fails closed with a fixed tagged error and strips raw provider defects", async () => {
  const exit = await snapshot(() => Effect.die(new Error("opaque.provider.failure")))
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) return
  expect(Cause.hasDies(exit.cause)).toBe(false)
  expect(Cause.pretty(exit.cause)).toContain("Secret output protection unavailable")
  expect(Cause.pretty(exit.cause)).not.toContain("opaque.provider.failure")
})

test("fails closed when extension reads fail or enumeration exceeds its work budget", async () => {
  const manifest = ExtensionCatalog.manifests.find((item) =>
    item.contributions.some((part) => part.secrets.length > 0),
  )!
  for (const extensions of [
    { manifests: () => Effect.die(new Error("opaque.manifest.failure")) },
    { manifests: () => Effect.succeed([manifest]), secret: () => Effect.die(new Error("opaque.extension.failure")) },
    { manifests: () => Effect.succeed(Array.from({ length: 4097 }, () => manifest)) },
    {
      manifests: () =>
        Effect.succeed([
          { ...manifest, contributions: Array.from({ length: 8193 }, () => manifest.contributions[0]!) },
        ]),
    },
  ]) {
    const exit = await snapshot(() => Effect.succeed([]), extensions)
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) continue
    expect(Cause.pretty(exit.cause)).toContain("Secret output protection unavailable")
    expect(Cause.pretty(exit.cause)).not.toContain("opaque.")
  }
})

test("preserves interruption without turning it into a credential failure", async () => {
  const exit = await snapshot(() => Effect.interrupt)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
})

test("rejects excessive credential counts and oversized values rather than silently omitting them", async () => {
  for (const rows of [
    Array.from({ length: 1025 }, () => key("opaque")),
    Array.from({ length: 257 }, (_, index) => key(`opaque.unique.${index}`)),
    [key("x".repeat(65537))],
    // Realistic high-variety values; repetitive dummies are ineligible and never count.
    [key(varied(40000, "abcdefghij")), key(varied(40000, "klmnopqrst"))],
  ]) {
    const exit = await snapshot(() => Effect.succeed(rows))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Secret output protection unavailable")
  }
})

function varied(length: number, alphabet: string) {
  return Array.from({ length }, (_, index) => alphabet[index % alphabet.length]).join("")
}

function key(value: string) {
  return new Credential.Info({
    id: Credential.ID.create(),
    integrationID: Integration.ID.make("synthetic"),
    label: "Test",
    value: Credential.Key.make({ type: "key", key: value }),
  })
}

test("does not mask ordinary text for short or placeholder provider keys", async () => {
  const exit = await snapshot(() =>
    Effect.succeed([key("ollama"), key("sk-no-key-required"), key("x"), key("opaque.cobalt.river.42")]),
  )
  expect(Exit.isSuccess(exit)).toBe(true)
  if (!Exit.isSuccess(exit)) return
  expect(exit.value.text("ollama serve x --api-key sk-no-key-required")).toBe(
    "ollama serve x --api-key sk-no-key-required",
  )
  expect(exit.value.text("key opaque.cobalt.river.42")).not.toContain("opaque.cobalt.river.42")
})

test("snapshots redact opaque provider values and refresh after rotation and deletion", async () => {
  const rows = [key("opaque.cobalt.river.42")]
  await Effect.gen(function* () {
    const output = yield* SecretOutput.Service
    const first = yield* output.snapshot()
    // Only redaction functions are exposed; no raw values are reachable from a snapshot.
    expect(Object.keys(first).sort()).toEqual(["boundary", "json", "text"])
    expect(Object.values(first).every((value) => typeof value === "function")).toBe(true)
    expect(first.text("value opaque.cobalt.river.42")).not.toContain("opaque.cobalt.river.42")
    expect(first.json({ nested: ["opaque.cobalt.river.42"] })).toEqual({
      nested: [first.text("opaque.cobalt.river.42")],
    })
    rows[0] = key("opaque.amber.moon.73")
    const second = yield* output.snapshot()
    expect(second.text("opaque.amber.moon.73")).not.toContain("opaque.amber.moon.73")
    expect(second.text("opaque.cobalt.river.42")).toBe("opaque.cobalt.river.42")
    expect(first.text("opaque.cobalt.river.42")).not.toContain("opaque.cobalt.river.42")
    rows.length = 0
    const third = yield* output.snapshot()
    expect(third.text("opaque.amber.moon.73")).toBe("opaque.amber.moon.73")
  }).pipe(
    Effect.provide(SecretOutput.layer.pipe(Layer.provide(providers(() => Effect.succeed(rows))))),
    Effect.runPromise,
  )
})
