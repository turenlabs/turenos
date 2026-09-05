import { type ContextItem, type Prompt, type usePrompt } from "@/context/prompt"

type PromptTarget = ReturnType<ReturnType<typeof usePrompt>["capture"]>

export function createPromptSubmissionState(input: {
  target: PromptTarget
  prompt: Prompt
  context: (ContextItem & { key: string })[]
}) {
  const initial = input.target
  const original = JSON.stringify(input.prompt)
  const originalContext = JSON.stringify(input.context)
  const originalModel = JSON.stringify(input.target.model.current())
  let target = input.target
  let expected = JSON.stringify(target.current())
  let preserved = false
  let cleared: Prompt | undefined

  return {
    prompt: input.prompt,
    context: input.context,
    target: () => target,
    preserve: () => {
      preserved = true
    },
    clear() {
      if (preserved || JSON.stringify(target.current()) !== expected) return false
      target.reset()
      cleared = target.current()
      return true
    },
    retarget(next: PromptTarget, latest = initial) {
      // A Session target can already have newer input from another mounted
      // composer. Keep both drafts in that case instead of replacing either.
      if (next !== latest && next.dirty() && JSON.stringify(next.current()) !== original) {
        preserved = true
        return false
      }
      const changed =
        JSON.stringify(latest.current()) !== original ||
        JSON.stringify(latest.context.items()) !== originalContext ||
        JSON.stringify(latest.model.current()) !== originalModel
      next.set(latest.current(), latest.cursor())
      next.model.set(latest.model.current())
      latest.context.items().forEach(next.context.add)
      preserved = changed
      target = next
      expected = JSON.stringify(next.current())
      return true
    },
    current: (value: PromptTarget) => target === value,
    restore() {
      if (preserved) return
      if (cleared === undefined && JSON.stringify(target.current()) !== expected) return
      if (cleared !== undefined && target.current() !== cleared) return
      return { target, prompt: input.prompt, context: input.context }
    },
  }
}
