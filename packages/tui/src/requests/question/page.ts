import { SelectRenderable } from "@opentui/core"
import { display } from "../../messages"
import { color } from "../../theme"
import { compactRows } from "../../dialogs/size"
import { matchesKey, printableKey } from "../../keys"
import { advance, answers, editCustom, text, type QuestionFlow, type Questions } from "./flow"

/** One question's page: a select of its options (plus "Type your own answer") and a description line. */
export function renderQuestionPage(flow: QuestionFlow, question: Questions[number]) {
  const { ctx, dialog, draft } = flow
  const page = flow.page
  text(flow, display(question.question))
  text(flow, question.multiple ? "Choose one or more answers" : "Choose one answer", true)
  const options = () => [
    ...question.options.map((option, index) => ({
      name: `${draft.selections[page]!.has(index) ? "[x]" : "[ ]"} ${display(option.label)}`,
      description: "",
    })),
    ...(question.custom !== false
      ? [{ name: `${draft.customOn[page] ? "[x]" : "[ ]"} Type your own answer`, description: "" }]
      : []),
  ]
  const choice = new SelectRenderable(ctx.renderer, {
    // Every option shows; the form scrolls if the dialog is short. A shorter list hid the last row behind a stray thumb.
    height: Math.max(1, options().length),
    flexShrink: 0,
    options: options(),
    selectedIndex: draft.cursors[page],
    showDescription: false,
    backgroundColor: color.bg,
    textColor: color.text,
    selectedTextColor: color.accent,
    selectedBackgroundColor: color.selected,
  })
  flow.picker = choice
  dialog.form.add(choice)
  ctx.dialogs.track(dialog, choice)
  const description = text(flow, "")
  description.fg = color.muted
  const describe = () => {
    const index = choice.getSelectedIndex()
    draft.cursors[page] = index
    const option = question.options[index]
    // The row above already names the option, so only its explanation shows, dimmed under the list.
    description.content = option
      ? display(option.description)
      : draft.custom[page]
        ? display(draft.custom[page]!)
        : "Select to type your own answer"
  }
  choice.on("selectionChanged", describe)
  describe()
  const select = (toggle: boolean) => selectOption(flow, question, choice, options, toggle)
  choice.on("itemSelected", () => {
    if (question.multiple && (choice.getSelectedIndex() < question.options.length || draft.customOn[page]))
      advance(flow)
    else select(false)
  })
  dialog.error.content = footer(flow, question)
  bindKeys(flow, question, choice, select)
  if (draft.editing) {
    draft.editing = false
    editCustom(flow, true)
  } else choice.focus()
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
  options: () => { name: string; description: string }[],
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
  const keys = question.multiple
    ? "↑↓ Move · Space or 1-9 Toggle · Enter Next"
    : `↑↓ or 1-9 Move · Enter Choose, then ${last ? "review answers" : "next question"}`
  if (flow.ctx.renderer.height < compactRows) return `${keys}\n←/→ Question · Ctrl+R Reject request · Esc close`
  return `${keys}\n←/→ Question · PgUp/PgDn Scroll\nCtrl+K Sessions · Ctrl+R Reject request · Esc close`
}
