import { describe, expect, test } from "bun:test"
import { Wildcard } from "@turenlabs/core/util/wildcard"

// Wildcard.match is the permission/policy matcher — these cases pin its wildcard,
// separator, and escaping semantics so a refactor can't silently widen a grant.
describe("Wildcard.match", () => {
  test("matches literals exactly and anchors both ends", () => {
    expect(Wildcard.match("foo", "foo")).toBe(true)
    expect(Wildcard.match("foobar", "foo")).toBe(false)
    expect(Wildcard.match("xfoo", "foo")).toBe(false)
  })

  test("* matches any run of characters", () => {
    expect(Wildcard.match("foo/bar", "foo*")).toBe(true)
    expect(Wildcard.match("anything", "*")).toBe(true)
    expect(Wildcard.match("foo/bar", "*bar")).toBe(true)
    expect(Wildcard.match("src/a.ts", "src/*.ts")).toBe(true)
  })

  test("* crosses path separators", () => {
    expect(Wildcard.match("foo/bar/baz", "foo/*")).toBe(true)
    expect(Wildcard.match("a/b/c", "a/*/c")).toBe(true)
  })

  test("** behaves like *", () => {
    expect(Wildcard.match("a/b/c", "a/**")).toBe(true)
    expect(Wildcard.match("a", "a/**")).toBe(false)
  })

  test("? matches exactly one character", () => {
    expect(Wildcard.match("aab", "a?b")).toBe(true)
    expect(Wildcard.match("ab", "a?b")).toBe(false)
    expect(Wildcard.match("acbb", "a?b")).toBe(false)
  })

  test("a trailing ' *' makes the space and suffix optional", () => {
    expect(Wildcard.match("git", "git *")).toBe(true)
    expect(Wildcard.match("git status", "git *")).toBe(true)
    expect(Wildcard.match("git status --all", "git *")).toBe(true)
    expect(Wildcard.match("gitx", "git *")).toBe(false)
  })

  test("backslashes normalize to forward slashes on both sides", () => {
    expect(Wildcard.match("a\\b\\c", "a/b/c")).toBe(true)
    expect(Wildcard.match("a/b/c", "a\\b\\c")).toBe(true)
    expect(Wildcard.match("a\\b\\c", "a/*/c")).toBe(true)
  })

  test("regex metacharacters in the pattern match literally", () => {
    expect(Wildcard.match("file.txt", "file.txt")).toBe(true)
    expect(Wildcard.match("fileXtxt", "file.txt")).toBe(false)
    expect(Wildcard.match("a+b", "a+b")).toBe(true)
    expect(Wildcard.match("aab", "a+b")).toBe(false)
    expect(Wildcard.match("a(b)", "a(b)")).toBe(true)
    expect(Wildcard.match("ab", "a(b)")).toBe(false)
    expect(Wildcard.match("a|b", "a|b")).toBe(true)
    expect(Wildcard.match("a$b", "a$b")).toBe(true)
  })

  test("empty inputs and patterns", () => {
    expect(Wildcard.match("", "*")).toBe(true)
    expect(Wildcard.match("", "")).toBe(true)
    expect(Wildcard.match("a", "")).toBe(false)
    expect(Wildcard.match("", "a*")).toBe(false)
  })

  test("case sensitivity follows the platform convention", () => {
    // win32 compiles with the `i` flag; posix stays case-sensitive.
    expect(Wildcard.match("README.md", "readme.md")).toBe(process.platform === "win32")
  })
})
