import { execFile } from "child_process"
import fs from "fs/promises"
import path from "path"
import { promisify } from "util"
import { pathToFileURL } from "url"
import { Repository } from "@turenlabs/core/repository"

const exec = promisify(execFile)

export async function gitRemote(root: string) {
  const origin = path.join(root, "origin.git")
  const source = path.join(root, "source")
  await runGit(root, "init", "--bare", origin)
  await runGit(root, "init", source)
  await runGit(source, "config", "user.email", "test@example.com")
  await runGit(source, "config", "user.name", "Test")
  await fs.writeFile(path.join(source, "README.md"), "one\n")
  await runGit(source, "add", "README.md")
  await runGit(source, "commit", "-m", "initial")
  await runGit(source, "branch", "-M", "main")
  await runGit(source, "remote", "add", "origin", pathToFileURL(origin).href)
  await runGit(source, "push", "-u", "origin", "main")
  await runGit(root, "--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main")
  return {
    root,
    source,
    remote: pathToFileURL(origin).href,
    reference: { ...Repository.parseRemote("owner/repo"), remote: pathToFileURL(origin).href },
  }
}

export async function commit(source: string, content: string, message: string) {
  await fs.writeFile(path.join(source, "README.md"), content)
  await runGit(source, "add", "README.md")
  await runGit(source, "commit", "-m", message)
  await runGit(source, "push")
}

export async function branch(source: string, name: string, content: string) {
  await runGit(source, "checkout", "-b", name)
  await fs.writeFile(path.join(source, "README.md"), content)
  await runGit(source, "add", "README.md")
  await runGit(source, "commit", "-m", name)
  await runGit(source, "push", "-u", "origin", name)
}

export async function runGit(cwd: string, ...args: string[]) {
  return exec("git", args, { cwd })
}
