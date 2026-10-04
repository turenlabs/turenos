import { SelectRenderable } from "@opentui/core"
import { display } from "../../messages"
import { color } from "../../theme"
import { matchesKey } from "../../keys"
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
    height: Math.max(1, Math.min(3, options().length)),
    flexShrink: 0,
    options: options(),
    selectedIndex: draft.cursors[page],
    showDescription: false,
    backgroundColor: color.bg,
    textColor: color.text,
    selectedTextColor: color.accent,
    selectedBackgroundColor: color.selected,
    showScrollIndicator: true,
  })
  flow.picker = choice
  dialog.form.add(choice)
  ctx.dialogs.track(dialog, choice)
  const description = text(flow, "")
  const describe = () => {
    const index = choice.getSelectedIndex()
    draft.cursors[page] = index
    const option = question.options[index]
    description.content = option
      ? `${display(option.label)}\n${display(option.description)}`
      : `Type your own answer${draft.custom[page] ? `\n${display(draft.custom[page]!)}` : ""}`
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
  // Handle Space here; native Select owns arrow movement, not toggling.
  choice.onKeyDown = (key) => {
    if (!matchesKey(key, "space") || flow.input) return
    key.preventDefault()
    select(true)
  }
  if (draft.editing) {
    draft.editing = false
    editCustom(flow, true)
  } else choice.focus()
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
    ? "↑↓ Move · Space Toggle · Enter Next"
    : `↑↓ Move · Enter Choose, then ${last ? "review answers" : "next question"}`
  return `${keys}\n←/→ Question · PgUp/PgDn Scroll\nCtrl+K Sessions · Ctrl+R Reject · Esc close`
}
