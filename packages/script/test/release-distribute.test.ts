import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  assertNotDowngrade,
  createPublicMirror,
  missingReleaseAssets,
  previousRelease,
} from "../../../script/release-distribute"
import { MIRROR_EXCLUSIONS } from "../src/release"

const release = (tag: string, options: { draft?: boolean; prerelease?: boolean } = {}) => ({
  id: 1,
  tag_name: tag,
  draft: false,
  prerelease: false,
  assets: [],
  ...options,
})

describe("release publication decisions", () => {
  test("fills only missing draft assets and refuses replacements or a published partial release", () => {
    const first = { id: 1, name: "one.zip", size: 1, digest: `sha256:${"a".repeat(64)}`, state: "uploaded" }
    const second = { ...first, id: 2, name: "two.zip" }
    expect(missingReleaseAssets([first, second], { draft: true, assets: [first] })).toEqual([second])
    expect(missingReleaseAssets([first, second], { draft: false, assets: [first, second] })).toEqual([])
    // An operator publishes between the initial plan and the next upload: stop,
    // rather than deleting/replacing anything or completing the partial release.
    expect(() => missingReleaseAssets([first, second], { draft: false, assets: [first] })).toThrow()
    expect(() =>
      missingReleaseAssets([first], { draft: true, assets: [{ ...first, digest: `sha256:${"b".repeat(64)}` }] }),
    ).toThrow()
    expect(() => missingReleaseAssets([first], { draft: true, assets: [first, second] })).toThrow()
    // A 'starter' record is an upload that never finalized server-side: it
    // counts as missing so the stuck record can be removed and re-uploaded.
    expect(
      missingReleaseAssets([first, second], { draft: true, assets: [first, { ...second, state: "starter" }] }),
    ).toEqual([second])
  })
  test("never moves latest behind a newer stable release, even when that release is not marked latest", () => {
    expect(() => assertNotDowngrade("1.0.11", [release("v1.0.12")])).toThrow("Refusing")
    expect(() => assertNotDowngrade("1.0.11", [release("v1.0.11"), release("v1.0.10")])).not.toThrow()
    expect(() =>
      assertNotDowngrade("1.0.11", [release("v1.0.12", { draft: true }), release("v2.0.0-beta", { prerelease: true })]),
    ).not.toThrow()
  })
  test("recovery chooses the previous release rather than its already-published target", () => {
    const old = release("v1.0.10")
    expect(previousRelease("1.0.11", [release("v1.0.11"), release("v1.0.9"), old])).toBe(old)
    expect(previousRelease("1.0.11", [])).toBeUndefined()
    expect(previousRelease("1.10.0", [release("v1.2.0"), release("v1.9.0")])?.tag_name).toBe("v1.9.0")
  })
})

test("public mirror keeps only public ancestry and never touches the real index", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-mirror-test-"))
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_COMMITTER_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
  }
  const git = (args: string[], extra?: Record<string, string>) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: root,
      env: { ...env, ...extra },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode).toBe(0)
    return result.stdout.toString().trim()
  }
  try {
    git(["init", "--quiet"])
    await Bun.write(path.join(root, "VERSION"), "1.0.10\n")
    git(["add", "VERSION"])
    const baseTree = git(["write-tree"])
    const publicParent = git(["commit-tree", baseTree, "-m", "public baseline"])
    for (const file of MIRROR_EXCLUSIONS) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await Bun.write(path.join(root, file), "private-only\n")
    }
    git(["add", "-f", "."])
    const privateParent = git(["commit-tree", git(["write-tree"]), "-m", "private baseline"])
    await Bun.write(path.join(root, "VERSION"), "1.0.11\n")
    await Bun.write(path.join(root, "product.ts"), "export const product = true\n")
    git(["add", "."])
    const source = git(["commit-tree", git(["write-tree"]), "-p", privateParent, "-m", "private release"])
    const indexBefore = git(["write-tree"])
    const mirrored = createPublicMirror(
      { source, parent: publicParent, version: "1.0.11", index: path.join(root, "mirror.index") },
      git,
    )
    expect(git(["write-tree"])).toBe(indexBefore)
    expect(git(["show", "-s", "--format=%P", mirrored])).toBe(publicParent)
    expect(git(["rev-list", mirrored]).split("\n")).toEqual([mirrored, publicParent])
    expect(git(["show", `${mirrored}:VERSION`])).toBe("1.0.11")
    expect(git(["diff", "--name-status", source, mirrored]).split("\n").sort()).toEqual(
      MIRROR_EXCLUSIONS.map((file) => `D\t${file}`).sort(),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("GitHub workflow owns the complete release and recovery skips rebuilding", async () => {
  const text = await Bun.file(new URL("../../../.github/workflows/release.yml", import.meta.url)).text()
  const workflow = Bun.YAML.parse(text) as {
    on: { workflow_dispatch: { inputs: Record<string, unknown> } }
    jobs: Record<
      string,
      {
        needs?: unknown
        if?: string
        permissions?: Record<string, string>
        steps: Array<{ name: string; env?: Record<string, string>; with?: Record<string, unknown>; run?: string }>
      }
    >
  }
  expect(workflow.on.workflow_dispatch.inputs.publish_existing).toBeDefined()
  expect(workflow.jobs.tests?.needs).toBe("release_context")
  expect(workflow.jobs.tests?.if).toContain("!inputs.publish_existing")
  expect(workflow.jobs.distribute?.needs).toEqual(["release_context", "publish"])
  expect(workflow.jobs.distribute?.if).toContain("!cancelled()")
  expect(workflow.jobs.distribute?.if).toContain("needs.publish.result == 'success'")
  expect(workflow.jobs.distribute?.permissions).toEqual({ contents: "read" })
  const publish = workflow.jobs.distribute!.steps.find((step) => step.run?.includes("release-distribute.ts"))!
  expect(publish.env?.PUBLIC_RELEASE_TOKEN).toBe("${{ secrets.PUBLIC_RELEASE_TOKEN }}")
  expect(JSON.stringify(workflow.jobs.distribute)).not.toContain("RELEASE_GPG_PRIVATE_KEY")
  expect(workflow.jobs.distribute!.steps[0]?.with?.["persist-credentials"]).toBe(false)
})
