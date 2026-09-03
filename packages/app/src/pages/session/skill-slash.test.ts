import { describe, expect, test } from "bun:test"
import type { ExtensionItem } from "@turenlabs/sdk/v2/client"
import { extensionSkillSlashOptions, resolveSkillSlash, visibleCustomSlashCommands } from "./skill-slash"

function skillItem(name: string, enabled = true): ExtensionItem {
  return {
    manifest: {
      schemaVersion: 1,
      id: `community/${name}`,
      name,
      description: `${name} description`,
      version: "1.0.0",
      publisher: "Community",
      trust: "community",
      contributions: [
        {
          type: "skill",
          id: name,
          name,
          description: `${name} description`,
          instructions: "Use defensively.",
          adapter: `skill:${name}`,
          secrets: [],
          defaultEnabled: false,
          source: { type: "catalog", content: "Review evidence." },
          requires: ["read"],
        },
      ],
    },
    origin: "catalog",
    mutable: true,
    enabled,
    status: enabled ? "available" : "disabled",
    installed: true,
    secretsSet: {},
    configurationSet: {},
  }
}

describe("skill slash commands", () => {
  test("discovers enabled Extension skills and omits disabled duplicates", () => {
    expect(
      extensionSkillSlashOptions([
        skillItem("threat-intel-brief"),
        skillItem("disabled-skill", false),
        skillItem("threat-intel-brief"),
      ]),
    ).toEqual([
      {
        id: "skill.threat-intel-brief",
        name: "threat-intel-brief",
        title: "threat-intel-brief",
        description: "threat-intel-brief description",
      },
    ])
  })

  test("resolves multiline skill arguments", () => {
    const options = extensionSkillSlashOptions([skillItem("threat-intel-brief")])
    const invocation = resolveSkillSlash("/threat-intel-brief 8.8.8.8\ninclude confidence", options)
    expect(invocation).toEqual({ name: "threat-intel-brief", arguments: "8.8.8.8\ninclude confidence" })
  })

  test("does not reinterpret unknown slash commands", () => {
    expect(
      resolveSkillSlash("/review target", extensionSkillSlashOptions([skillItem("threat-intel-brief")])),
    ).toBeUndefined()
  })

  test("removes legacy skill projections from the custom-command list", () => {
    expect(
      visibleCustomSlashCommands([
        { name: "review", source: "command" as const },
        { name: "threat-intel-brief", source: "skill" as const },
        { name: "mcp-action", source: "mcp" as const },
      ]),
    ).toEqual([
      { name: "review", source: "command" },
      { name: "mcp-action", source: "mcp" },
    ])
  })
})
