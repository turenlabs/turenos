import { expect, test } from "bun:test"
import { createForgeClient } from "../src/v2/client"
import type {
  StorageGetResult,
  StorageGuardedBatchInput,
  StorageReceiptResult,
  StorageReplaceInput,
  StorageRevisionConflictError,
  StorageSetInput,
} from "../src/v2/gen/types.gen"

test("generated client exposes Storage operations", () => {
  const client = createForgeClient({ baseUrl: "http://localhost:4096" })

  expect(typeof client.storage.get).toBe("function")
  expect(typeof client.storage.list).toBe("function")
  expect(typeof client.storage.set).toBe("function")
  expect(typeof client.storage.remove).toBe("function")
  expect(typeof client.storage.replace).toBe("function")
  expect(typeof client.storage.guardedBatch).toBe("function")
  expect(typeof client.storage.clear).toBe("function")
  expect(typeof client.storage.receipt).toBe("function")
  expect(typeof client.storage.import).toBe("function")
})

test("generated Storage types preserve nullable wire fields", () => {
  const input = {
    scope: "desktop/store/test",
    key: "value",
    value: "data",
    expectedRevision: null,
  } satisfies StorageSetInput
  const missing = { state: null } satisfies StorageGetResult
  const receipt = { receipt: null } satisfies StorageReceiptResult
  const replacement = {
    scope: input.scope,
    entries: [
      { key: "meta", value: "metadata" },
      { key: "chunk-0", value: "chunk" },
    ],
  } satisfies StorageReplaceInput
  const guarded = {
    guards: [{ scope: input.scope, key: input.key, expectedRevision: null }],
    sets: [{ scope: input.scope, key: input.key, value: "next" }],
    removes: [],
  } satisfies StorageGuardedBatchInput
  const conflict = {
    _tag: "StorageRevisionConflictError",
    scope: input.scope,
    key: input.key,
    expected: null,
    actual: null,
  } satisfies StorageRevisionConflictError

  expect(input.expectedRevision).toBeNull()
  expect(missing.state).toBeNull()
  expect(receipt.receipt).toBeNull()
  expect(replacement.entries).toHaveLength(2)
  expect(guarded.guards).toHaveLength(1)
  expect(conflict.actual).toBeNull()
})
