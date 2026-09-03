/** Fidelity check: harness split/serialization must agree with production `select`. */
import { select } from "../../../../src/session/compaction"
import { items, load, serializeMessage, splitIndex } from "./lib"

const SESSIONS = ["ses_050344a2cffe66piKLHcymP9sn", "ses_05108d761ffe56ZB8U33Zwpja5", "ses_04797a900ffe9w2drITJ0OtdBi"]
let checks = 0
let mismatches = 0
for (const id of SESSIONS) {
  const entries = load(id)
  for (const tokens of [4000, 8000, 16000, 32000]) {
    for (const cut of [10, 25, 50, 80]) {
      const slice = entries.slice(0, Math.min(cut, entries.length))
      if (slice.length < 3) continue
      const production = select(slice as any, { tokens, turns: 2 })
      const list = items(slice, serializeMessage)
      const { split } = splitIndex(list, { tokens, turns: 2 })
      const head = list
        .slice(0, split)
        .map((i) => i.text)
        .join("\n\n")
      const recent = list
        .slice(split)
        .map((i) => i.text)
        .join("\n\n")
      checks++
      // Production prepends the newest user line when the tail carries none; compare on the
      // head (which drives summarization) and on the tail's tail.
      const headOk = (production?.head ?? "") === head
      const recentOk = (production?.recent ?? "").endsWith(recent)
      if (!headOk || !recentOk) {
        mismatches++
        console.log(
          `MISMATCH ${id} tokens=${tokens} cut=${cut} headOk=${headOk} recentOk=${recentOk} prodHead=${production?.head.length} mineHead=${head.length} prodRecent=${production?.recent.length} mineRecent=${recent.length}`,
        )
      }
    }
  }
}
console.log(`${checks - mismatches}/${checks} splits match production select()`)
