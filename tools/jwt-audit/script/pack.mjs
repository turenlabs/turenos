import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const tool = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const source = path.resolve(process.argv[2])
const target = path.resolve(process.argv[3])
await rm(target, { recursive: true, force: true })
await mkdir(path.join(target, "dist"), { recursive: true })
await cp(source, path.join(target, "dist"), { recursive: true })
await rm(path.join(target, "dist/.gitignore"), { force: true })
await cp(path.join(tool, "LICENSE.txt"), path.join(target, "dist/LICENSE.txt"))
await rm(path.join(target, "dist/LICENSE"), { force: true })
for (const file of ["LICENSE.txt", "NOTICE.txt", "README.md"])
  await cp(path.join(tool, file), path.join(target, file))
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    ["metadata", "--locked", "--format-version=1", "--manifest-path", path.join(tool, "Cargo.toml")],
    { encoding: "utf8" },
  ),
)
const dependencies = metadata.packages.filter((pkg) => pkg.source).sort((a, b) => a.name.localeCompare(b.name))
const notices = []
for (const pkg of dependencies) {
  const root = path.dirname(pkg.manifest_path)
  const files = (await readdir(root)).filter((name) => /^(license|copying|notice)([.-]|$)/i.test(name))
  if (!files.length) throw new Error(`Missing license files for ${pkg.name}`)
  for (const file of files)
    notices.push(
      `${pkg.name} ${pkg.version} (${pkg.license}) / ${file}\n${await readFile(path.join(root, file), "utf8")}`,
    )
}
await writeFile(path.join(target, "LICENSE.dependencies.txt"), `${notices.join("\n\n")}\n`)
await writeFile(
  path.join(target, "SOURCE.json"),
  `${JSON.stringify(
    {
      ...JSON.parse(await readFile(path.join(tool, "SOURCE.json"), "utf8")),
      lockfileSha256: createHash("sha256")
        .update(await readFile(path.join(tool, "Cargo.lock")))
        .digest("hex"),
      compiler: execFileSync("rustc", ["+1.97.1", "--version"], { encoding: "utf8" }).trim(),
      workflowRun: process.env.GITHUB_RUN_ID ?? null,
      workflowSourceCommit: process.env.GITHUB_SHA ?? null,
      sourceSha256: Object.fromEntries(
        await Promise.all(
          ["Cargo.toml", "Cargo.lock", "src/lib.rs"].map(async (name) => [
            name,
            createHash("sha256")
              .update(await readFile(path.join(tool, name)))
              .digest("hex"),
          ]),
        ),
      ),
      dependencies: await Promise.all(
        dependencies.map(async (pkg) => ({
          name: pkg.name,
          version: pkg.version,
          source: pkg.source,
          repository: pkg.repository,
          license: pkg.license,
          upstreamCommit: await readFile(path.join(path.dirname(pkg.manifest_path), ".cargo_vcs_info.json"), "utf8")
            .then((text) => JSON.parse(text).git?.sha1 ?? null)
            .catch(() => null),
        })),
      ),
    },
    null,
    2,
  )}\n`,
)
await writeFile(
  path.join(target, "package.json"),
  `${JSON.stringify(
    {
      name: "@turenlabs/jwt-audit-wasm",
      version: "0.1.0",
      private: true,
      type: "module",
      license: "MIT",
      repository: "https://github.com/turenlabs/turenos",
      exports: "./dist/turen_jwt_audit_wasm.js",
      files: ["dist/", "LICENSE.txt", "LICENSE.dependencies.txt", "NOTICE.txt", "README.md", "SOURCE.json", "SHA256SUMS"],
    },
    null,
    2,
  )}\n`,
)
async function files(directory, prefix = "") {
  return (
    await Promise.all(
      (await readdir(path.join(directory, prefix), { withFileTypes: true })).map((entry) => {
        const name = path.join(prefix, entry.name)
        return entry.isDirectory() ? files(directory, name) : [name]
      }),
    )
  ).flat()
}
const checksums = await Promise.all(
  (await files(target))
    .filter((name) => name !== "SHA256SUMS")
    .map(
      async (name) =>
        `${createHash("sha256")
          .update(await readFile(path.join(target, name)))
          .digest("hex")}  ${name}`,
    ),
)
await writeFile(path.join(target, "SHA256SUMS"), `${checksums.sort((a, b) => a.localeCompare(b)).join("\n")}\n`)
