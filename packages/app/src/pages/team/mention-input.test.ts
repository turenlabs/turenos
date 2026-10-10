import { describe, expect, test } from "bun:test"
import type { Team } from "@turenlabs/schema/team"
import { insertMention, mentionMatches, mentionToken } from "./mention-input"

describe("team mention input", () => {
  test("matches only the token at the caret with a valid mention boundary", () => {
    expect(mentionToken("@", 1)).toEqual({ start: 0, end: 1, query: "" })
    expect(mentionToken("Hello (@Mo", 10)).toEqual({ start: 7, end: 10, query: "Mo" })
    expect(mentionToken("First @rae\n@moss", 16)).toEqual({ start: 11, end: 16, query: "moss" })
    expect(mentionToken("email@moss", 10)).toBeUndefined()
    expect(mentionToken("user_@moss", 10)).toBeUndefined()
    expect(mentionToken("@moss done", 10)).toBeUndefined()
    expect(mentionToken("@123", 4)).toBeUndefined()
    expect(mentionToken("@moss", 0)).toBeUndefined()
    expect(mentionToken("@moss", 5, 2)).toBeUndefined()
    expect(mentionToken("@moss", 6)).toBeUndefined()
  })

  test("inserts at the current caret and keeps all text after the caret", () => {
    const value = "Ask @mo, then @rae"
    const token = mentionToken(value, 7)!
    expect(token).toEqual({ start: 4, end: 7, query: "mo" })
    expect(insertMention(value, token, "moss")).toEqual({ value: "Ask @moss , then @rae", caret: 10 })
    expect(insertMention("@moSuffix", mentionToken("@moSuffix", 3)!, "moss")).toEqual({
      value: "@moss Suffix",
      caret: 6,
    })
  })

  test("supports handle hyphens and underscores without completing old tokens", () => {
    expect(mentionToken("@rae-", 5)?.query).toBe("rae-")
    expect(mentionToken("@rae_one", 8)?.query).toBe("rae_one")
    expect(mentionToken("@moss @", 7)).toEqual({ start: 6, end: 7, query: "" })
    expect(mentionToken(`@${"a".repeat(33)}`, 34)).toBeUndefined()
  })

  test("filters handle, name and role without excluding paused teammates", () => {
    const teammates = [
      { id: "moss", handle: "moss", name: "Morgan", role: "Engineer", status: "active" },
      { id: "rae", handle: "rae-", name: "Rachel", role: "Reviewer", status: "paused" },
    ] as Team.Teammate[]
    expect(mentionMatches(teammates, "MOSS")).toEqual([teammates[0]!])
    expect(mentionMatches(teammates, "mor")).toEqual([teammates[0]!])
    expect(mentionMatches(teammates, "REVIEW")).toEqual([teammates[1]!])
    expect(mentionMatches(teammates, "")).toEqual(teammates)
    expect(mentionMatches(teammates, "unknown")).toEqual([])
  })
})
