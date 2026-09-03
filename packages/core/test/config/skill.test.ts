import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@turenlabs/core/agent"
import { Config } from "@turenlabs/core/config"
import { ConfigSkillPlugin } from "@turenlabs/core/config/plugin/skill"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Global } from "@turenlabs/core/global"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SkillV2 } from "@turenlabs/core/skill"
import { SkillDiscovery } from "@turenlabs/core/skill/discovery"
import { SkillGuidance } from "@turenlabs/core/skill/guidance"
import { SystemContext } from "@turenlabs/core/system-context"
import { SkillTool } from "@turenlabs/core/tool/skill"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { tmpdir } from "../fixture/tmpdir"
import { it } from "../lib/effect"
import { executeTool, toolIdentity } from "../lib/tool"
import { host } from "../plugin/host"

const assertions: PermissionV2.AssertInput[] = []
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const layer = LayerNode.compile(
  LayerNode.group([SkillV2.node, SkillGuidance.node, ToolRegistry.node, ToolRegistry.toolsNode, SkillTool.node]),
  [
    [PermissionV2.node, permission],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ],
)
const sessionID = SessionV2.ID.make("ses_config_skill_test")
const markdown = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`

describe("ConfigSkillPlugin.Plugin", () => {
  it.live("resolves ordered config sources into lazy permission-checked skills", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const low = path.join(tmp.path, "low")
          const high = path.join(tmp.path, "high")
          const remote = path.join(tmp.path, "remote-skill")
          yield* Effect.promise(() =>
            Promise.all([
              writeSkill(path.join(low, "skills"), "same", markdown("same", "Low", "low guidance")),
              writeSkill(path.join(high, "first"), "same", markdown("same", "High", "high guidance")),
              writeSkill(path.join(high, "second"), "same", markdown("same", "Second", "second guidance")),
              fs
                .mkdir(remote, { recursive: true })
                .then(() =>
                  fs.writeFile(path.join(remote, "SKILL.md"), markdown("remote", "Remote", "remote guidance")),
                ),
            ]),
          )
          const documents = [
            document(path.join(low, "forge.json"), ["./skills"]),
            document(path.join(high, "forge.json"), [
              "./first",
              "./second",
              "https://skills.example.test/catalog",
              "https://skills.example.test/catalog/",
            ]),
          ]
          const pulls: string[] = []
          const skills = yield* SkillV2.Service
          yield* ConfigSkillPlugin.Plugin.effect(host({ skill: { ...skills, reload: skills.reload } })).pipe(
            Effect.provideService(Config.Service, Config.Service.of({ entries: () => Effect.succeed(documents) })),
            Effect.provideService(
              Global.Service,
              Global.Service.of(Global.make({ home: path.join(tmp.path, "home") })),
            ),
            Effect.provideService(
              SkillDiscovery.Service,
              SkillDiscovery.Service.of({
                pull: (url) =>
                  Effect.sync(() => {
                    pulls.push(url)
                    return [AbsolutePath.make(remote)]
                  }),
              }),
            ),
          )

          expect(pulls).toEqual(["https://skills.example.test/catalog/"])
          expect((yield* skills.sources()).map(SkillV2.Source.key)).toEqual([
            `directory:${path.join(high, "first")}`,
            `directory:${path.join(high, "second")}`,
            `directory:${remote}`,
            `directory:${path.join(low, "skills")}`,
          ])
          expect(yield* skills.list()).toEqual([
            expect.objectContaining({ name: "same", description: "High", content: "high guidance" }),
            expect.objectContaining({ name: "remote", description: "Remote", content: "remote guidance" }),
          ])

          const agent = AgentV2.Info.make({ ...AgentV2.Info.empty(AgentV2.ID.make("build")), permissions: [] })
          const guidance = yield* SkillGuidance.Service
          expect(
            (yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize)))
              .baseline,
          ).toContain("<name>remote</name>")

          assertions.length = 0
          const registry = yield* ToolRegistry.Service
          expect(
            yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: "call-config-skill", name: "skill", input: { name: "remote" } },
            }),
          ).toEqual({
            type: "text",
            value: expect.stringContaining("remote guidance"),
          })
          expect(assertions).toMatchObject([{ sessionID, action: "skill", resources: ["remote"] }])
        }).pipe(Effect.provide(layer)),
      ),
    ),
  )

  it.effect("resolves local paths deliberately and accepts only credential-free HTTPS indexes", () =>
    Effect.sync(() => {
      const home = path.resolve("/home/tester")
      const config = path.resolve("/project/.forge/forge.json")
      expect(ConfigSkillPlugin.resolveSource("./skills", config, home)).toMatchObject({
        type: "directory",
        directory: path.resolve("/project/.forge/skills"),
      })
      expect(ConfigSkillPlugin.resolveSource("~/skills", config, home)).toMatchObject({
        type: "directory",
        directory: path.resolve("/home/tester/skills"),
      })
      expect(ConfigSkillPlugin.resolveSource("https://skills.example.test/root", config, home)).toEqual({
        type: "remote",
        url: "https://skills.example.test/root/",
      })
      for (const source of [
        "http://skills.example.test/root",
        "https://user:secret@skills.example.test/root",
        "https://skills.example.test/root?token=secret",
        " https://skills.example.test/root",
      ]) {
        expect(ConfigSkillPlugin.resolveSource(source, config, home)).toBeUndefined()
      }
      expect(ConfigSkillPlugin.resolveSource("./skills", undefined, home)).toBeUndefined()
    }),
  )
})

function document(filepath: string, skills: string[]) {
  return new Config.Document({ type: "document", path: filepath, info: new Config.Info({ skills }) })
}

async function writeSkill(root: string, folder: string, content: string) {
  await fs.mkdir(path.join(root, folder), { recursive: true })
  await fs.writeFile(path.join(root, folder, "SKILL.md"), content)
}
