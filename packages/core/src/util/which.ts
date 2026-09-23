import whichPkg from "which"
import path from "path"
import { Global } from "../global"

function userBinDirs() {
  if (process.platform === "win32") return []
  return [path.join(Global.Path.home, ".local", "bin"), path.join(Global.Path.home, "bin")]
}

export function which(cmd: string, env?: NodeJS.ProcessEnv) {
  const base = env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? ""
  const fallbacks = [Global.Path.bin, ...userBinDirs()].join(path.delimiter)
  const full = base ? base + path.delimiter + fallbacks : fallbacks
  const result = whichPkg.sync(cmd, {
    nothrow: true,
    path: full,
    pathExt: env?.PATHEXT ?? env?.PathExt ?? process.env.PATHEXT ?? process.env.PathExt,
  })
  return typeof result === "string" ? result : null
}
