import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SkillV2 } from "@turenlabs/core/skill"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([SkillV2.node])))
const source = (directory: string): SkillV2.DirectorySource =>
  SkillV2.DirectorySource.make({ type: "directory", directory: AbsolutePath.make(directory) })
const markdown = (frontmatter: string, body: string) => `---\n${frontmatter}---\n${body}`

const withDirectory = <A, E, R>(body: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => body(tmp.path),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const write = (directory: string, folder: string, filename: string, content: string) =>
  Effect.promise(async () => {
    const child = path.join(directory, folder)
    await fs.mkdir(child, { recursive: true })
    await fs.writeFile(path.join(child, filename), content)
  })

const register = (directory: string, ...sources: SkillV2.Source[]) =>
  Effect.gen(function* () {
    const skills = yield* SkillV2.Service
    yield* skills.transform((draft) => sources.forEach((item) => draft.source(item)))
    return skills
  })

describe("SkillV2 directory source", () => {
  it.effect("loads SKILL.md frontmatter and markdown body", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        yield* write(
          directory,
          "my-skill",
          "SKILL.md",
          markdown("name: My Skill\ndescription: Does things\n", "# Body\nUse it."),
        )
        const skills = yield* register(directory, source(directory))
        expect(yield* skills.list()).toEqual([
          expect.objectContaining({
            name: "My Skill",
            description: "Does things",
            location: AbsolutePath.make(path.join(directory, "my-skill", "SKILL.md")),
            content: "# Body\nUse it.",
          }),
        ])
      }),
    ),
  )

  it.effect("prefers frontmatter names and falls back to the folder name", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        yield* write(directory, "folder-name", "SKILL.md", markdown("name: Authored Name\n", "named"))
        yield* write(directory, "fallback", "SKILL.md", markdown("description: No explicit name\n", "fallback"))
        const skills = yield* register(directory, source(directory))
        expect((yield* skills.list()).map((item) => item.name).sort()).toEqual(["Authored Name", "fallback"])
      }),
    ),
  )

  it.effect("loads the folder-named markdown entry form", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        yield* write(
          directory,
          "folder-skill",
          "folder-skill.md",
          markdown("description: Folder entry\n", "folder body"),
        )
        const skills = yield* register(directory, source(directory))
        expect(yield* skills.list()).toContainEqual(
          expect.objectContaining({ name: "folder-skill", content: "folder body" }),
        )
      }),
    ),
  )

  it.effect("loads a source directory that directly contains its skill entry", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(directory, "SKILL.md"),
            markdown("name: remote-skill\ndescription: Remote\n", "remote"),
          ),
        )
        yield* write(directory, "references", "notes.md", markdown("name: Not a nested skill\n", "ignored"))
        const skills = yield* register(directory, source(directory))
        expect(yield* skills.list()).toEqual([
          expect.objectContaining({ name: "remote-skill", description: "Remote", content: "remote" }),
        ])
      }),
    ),
  )

  it.effect("skips an invalid child while retaining valid siblings", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        yield* write(directory, "thing", "notes.md", markdown("name: Not an entry\n", "ignored"))
        yield* write(directory, "valid", "SKILL.md", markdown("name: Valid\n", "kept"))
        const skills = yield* register(directory, source(directory))
        expect(yield* skills.list()).toEqual([expect.objectContaining({ name: "Valid", content: "kept" })])
      }),
    ),
  )

  it.effect("deduplicates directories while allowing embedded and directory sources together", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        yield* write(directory, "directory-skill", "SKILL.md", markdown("description: Directory\n", "directory"))
        const embedded: SkillV2.EmbeddedSource = {
          type: "embedded",
          skill: {
            name: "embedded-skill",
            description: "Embedded",
            location: AbsolutePath.make("/embedded.md"),
            content: "embedded",
          },
        }
        const skills = yield* register(directory, source(directory), source(directory), embedded)
        expect((yield* skills.sources()).map(SkillV2.Source.key)).toEqual([
          `directory:${directory}`,
          "embedded:embedded-skill",
        ])
        expect((yield* skills.list()).map((item) => item.name).sort()).toEqual(["directory-skill", "embedded-skill"])
      }),
    ),
  )

  it.effect("uses the first source's skill on duplicate names", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        yield* write(directory, "same", "SKILL.md", markdown("name: same\n", "directory version"))
        const embedded: SkillV2.EmbeddedSource = {
          type: "embedded",
          skill: { name: "same", location: AbsolutePath.make("/embedded.md"), content: "embedded version" },
        }
        const skills = yield* register(directory, embedded, source(directory))
        expect(yield* skills.list()).toEqual([expect.objectContaining({ name: "same", content: "embedded version" })])
      }),
    ),
  )
})
