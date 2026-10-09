import { SelectRenderable } from "@opentui/core"
import { display } from "../../messages"
import { color } from "../../theme"
import { compactRows } from "../../dialogs/size"
import { matchesKey, printableKey } from "../../keys"
import { advance, answers, editCustom, hints, text, type QuestionFlow, type Questions } from "./flow"

/** Longest description that still fits under its option on the narrowest terminal. */
const underLimit = 44

/** One question's page: a select of its options (plus "Type your own answer") and a description line. */
export function renderQuestionPage(flow: QuestionFlow, question: Questions[number]) {
  const { ctx, dialog, draft } = flow
  const page = flow.page
  text(flow, display(question.question))
  text(flow, question.multiple ? "Choose one or more answers" : "Choose one answer", true)
  const { under, options } = optionRows(flow, question)
  const choice = new SelectRenderable(ctx.renderer, {
    // Every option shows; the form scrolls if the dialog is short. A shorter list hid the last row behind a stray thumb.
    height: Math.max(1, options().length * (under ? 2 : 1)),
    flexShrink: 0,
    options: options(),
    selectedIndex: draft.cursors[page],
    showDescription: under,
    backgroundColor: color.bg,
    textColor: color.text,
    descriptionColor: color.muted,
    selectedTextColor: color.accent,
    selectedBackgroundColor: color.selected,
  })
  flow.picker = choice
  dialog.form.add(choice)
  ctx.dialogs.track(dialog, choice)
  const described = question.options.some((option) => option.description.trim())
  const description = under || !described ? undefined : text(flow, "")
  if (description) description.fg = color.muted
  const describe = () => {
    const index = choice.getSelectedIndex()
    draft.cursors[page] = index
    if (!description) return
    const option = question.options[index]
    // A long list cannot show a line under each option, so the line below names the option it explains.
    description.content = option?.description.trim() ? `  ${display(option.label)}: ${display(option.description)}` : ""
  }
  choice.on("selectionChanged", describe)
  describe()
  const select = (toggle: boolean) => selectOption(flow, question, choice, options, toggle)
  choice.on("itemSelected", () => {
    if (question.multiple && (choice.getSelectedIndex() < question.options.length || draft.customOn[page]))
      advance(flow)
    else select(false)
  })
  footer(flow, question)
  bindKeys(flow, question, choice, select)
  if (draft.editing) {
    draft.editing = false
    editCustom(flow, true)
  } else choice.focus()
}

type Row = { name: string; description: string }

/** The option rows, and whether each carries its description under it (a short list) or the page shows one line below. */
function optionRows(flow: QuestionFlow, question: Questions[number]) {
  const { draft, page } = flow
  // A row under an option is one line, so a long description keeps the wrapped line below the list instead.
  const under =
    question.options.length + (question.custom !== false ? 1 : 0) <= 5 &&
    question.options.some((option) => option.description.trim()) &&
    question.options.every((option) => display(option.description).length <= underLimit)
  const mark = (on: boolean) => (question.multiple ? (on ? "[x]" : "[ ]") : on ? "(•)" : "( )")
  const options = (): Row[] => [
    ...question.options.map((option, index) => ({
      name: `${mark(draft.selections[page]!.has(index))} ${display(option.label)}`,
      description: under ? display(option.description).replace(/\s+/g, " ") : "",
    })),
    ...(question.custom !== false
      ? [
          {
            name: `${mark(draft.customOn[page]!)} Type your own answer`,
            description: under && draft.custom[page] ? display(draft.custom[page]!).replace(/\s+/g, " ") : "",
          },
        ]
      : []),
  ]
  return { under, options }
}

/** Space and digits are handled here; native Select owns arrow movement, not toggling. Digits never confirm. */
function bindKeys(
  flow: QuestionFlow,
  question: Questions[number],
  choice: SelectRenderable,
  select: (toggle: boolean) => void,
) {
  choice.onKeyDown = (key) => {
    if (flow.input) return
    const digit = Number(printableKey(key))
    if (digit >= 1 && digit <= choice.options.length) {
      key.preventDefault()
      choice.setSelectedIndex(digit - 1)
      if (question.multiple) select(true)
      return
    }
    if (!matchesKey(key, "space")) return
    key.preventDefault()
    select(true)
  }
}

function selectOption(
  flow: QuestionFlow,
  question: Questions[number],
  choice: SelectRenderable,
  options: () => Row[],
  toggle: boolean,
) {
  if (flow.dialog.busy) return
  const { selections, customOn } = flow.draft
  const page = flow.page
  const index = choice.getSelectedIndex()
  if (index === question.options.length && question.custom !== false) {
    if (toggle && question.multiple && customOn[page]) {
      customOn[page] = false
      flow.render()
      return
    }
    editCustom(flow)
    return
  }
  if (!question.options[index]) return
  if (question.multiple) {
    if (selections[page]!.has(index)) selections[page]!.delete(index)
    else selections[page]!.add(index)
    choice.options = options()
    choice.setSelectedIndex(index)
    return
  }
  selections[page]!.clear()
  selections[page]!.add(index)
  customOn[page] = false
  advance(flow)
}

/** The key hints, which say where Enter goes so choosing and moving on is never a surprise. */
function footer(flow: QuestionFlow, question: Questions[number]) {
  const last = answers(flow).every((answer, index) => index === flow.page || answer.length > 0)
  hints(
    flow,
    [
      ...(question.multiple
        ? ["↑↓ move", "Space or 1-9 toggle", "Enter next"]
        : ["↑↓ or 1-9 move", `Enter choose, then ${last ? "review answers" : "next question"}`]),
      ...(flow.ctx.renderer.height < compactRows ? [] : ["PgUp/PgDn scroll", "Ctrl+K sessions"]),
    ],
    ["←/→ question", "Ctrl+R reject request", "Esc close"],
  )
}
