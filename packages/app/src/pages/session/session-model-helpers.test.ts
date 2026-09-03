import { describe, expect, test } from "bun:test"
import type { UserMessage } from "@turenlabs/sdk/v2"
import { resetSessionModel, restorePromptModel, syncPromptModel, syncSessionModel } from "./session-model-helpers"

const message = (input?: { agent?: string; model?: UserMessage["model"] }) =>
  ({
    id: "msg",
    sessionID: "session",
    role: "user",
    time: { created: 1 },
    agent: input?.agent ?? "build",
    model: input?.model ?? { providerID: "anthropic", modelID: "claude-sonnet-4" },
  }) as UserMessage

describe("syncSessionModel", () => {
  test("restores the last message through session state", () => {
    const calls: unknown[] = []

    syncSessionModel(
      {
        session: {
          restore(value) {
            calls.push(value)
          },
          reset() {},
        },
      },
      message({ model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" } }),
    )

    expect(calls).toEqual([
      message({ model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" } }),
    ])
  })
})

describe("resetSessionModel", () => {
  test("clears draft session state", () => {
    const calls: string[] = []

    resetSessionModel({
      session: {
        reset() {
          calls.push("reset")
        },
        restore() {},
      },
    })

    expect(calls).toEqual(["reset"])
  })
})

describe("syncPromptModel", () => {
  test("stores the effective session model in prompt state", () => {
    const calls: unknown[] = []

    syncPromptModel(
      {
        model: {
          current: () => ({ id: "claude-sonnet-4", provider: { id: "anthropic" } }),
          variant: { current: () => "high" },
        },
      },
      {
        model: {
          current: () => undefined,
          set: (model) => calls.push(model),
        },
      },
    )

    expect(calls).toEqual([{ providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" }])
  })

  test("does not rewrite an unchanged prompt model", () => {
    const calls: unknown[] = []
    const model = { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" }

    syncPromptModel(
      {
        model: {
          current: () => ({ id: model.modelID, provider: { id: model.providerID } }),
          variant: { current: () => model.variant },
        },
      },
      {
        model: {
          current: () => model,
          set: (value) => calls.push(value),
        },
      },
    )

    expect(calls).toEqual([])
  })

  test("replaces a stale prompt model with the current session selection", () => {
    const calls: unknown[] = []

    syncPromptModel(
      {
        model: {
          current: () => ({ id: "gpt-5.6-sol", provider: { id: "openai" } }),
          variant: { current: () => "high" },
        },
      },
      {
        model: {
          current: () => ({ providerID: "openai", modelID: "gpt-5.6-luna", variant: "high" }),
          set: (model) => calls.push(model),
        },
      },
    )

    expect(calls).toEqual([{ providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" }])
  })
})

describe("restorePromptModel", () => {
  test("restores the persisted prompt model when the session has no saved model", () => {
    const calls: unknown[] = []
    const restored = restorePromptModel(
      {
        session: { hasState: () => false },
        model: {
          current: () => ({ id: "gpt", provider: { id: "openai" } }),
          set: (model) => calls.push(model),
          variant: {
            current: () => undefined,
            set: (variant) => calls.push(variant),
          },
        },
      },
      {
        model: {
          current: () => ({ providerID: "anthropic", modelID: "claude", variant: "high" }),
        },
      },
    )

    expect(restored).toBe(true)
    expect(calls).toEqual([{ providerID: "anthropic", modelID: "claude" }, "high"])
  })

  test("keeps a saved session model authoritative over stale prompt state", () => {
    const calls: unknown[] = []
    const restored = restorePromptModel(
      {
        session: { hasState: () => true },
        model: {
          current: () => ({ id: "gpt-5.6-sol", provider: { id: "openai" } }),
          set: (model) => calls.push(model),
          variant: {
            current: () => "high",
            set: (variant) => calls.push(variant),
          },
        },
      },
      {
        model: {
          current: () => ({ providerID: "openai", modelID: "gpt-5.6-luna", variant: "high" }),
        },
      },
    )

    expect(restored).toBe(false)
    expect(calls).toEqual([])
  })

  test("materializes prompt state that matches the effective fallback", () => {
    const calls: unknown[] = []
    const restored = restorePromptModel(
      {
        session: { hasState: () => false },
        model: {
          current: () => ({ id: "gpt-5.6-sol", provider: { id: "openai" } }),
          set: (model) => calls.push(model),
          variant: {
            current: () => "high",
            set: (variant) => calls.push(variant),
          },
        },
      },
      {
        model: {
          current: () => ({ providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" }),
        },
      },
    )

    expect(restored).toBe(true)
    expect(calls).toEqual([{ providerID: "openai", modelID: "gpt-5.6-sol" }, "high"])
  })

  test("does nothing without a persisted prompt model", () => {
    const calls: unknown[] = []
    const restored = restorePromptModel(
      {
        session: { hasState: () => false },
        model: {
          current: () => ({ id: "gpt", provider: { id: "openai" } }),
          set: (model) => calls.push(model),
          variant: {
            current: () => undefined,
            set: (variant) => calls.push(variant),
          },
        },
      },
      {
        model: {
          current: () => undefined,
        },
      },
    )

    expect(restored).toBe(false)
    expect(calls).toEqual([])
  })
})
