import { Watcher } from "@turenlabs/core/filesystem/watcher"
import { available } from "@turenlabs/core/filesystem/fff.bun"

if (!process.versions.bun) throw new Error("Native backend checks require Bun")
const platform = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform
if (process.env.TARGET && process.env.TARGET !== `${platform}-${process.arch}`)
  throw new Error(`Expected ${process.env.TARGET}, got ${platform}-${process.arch}`)
if (!Watcher.hasNativeBinding()) throw new Error("The target file watcher failed to load")
if (!available()) throw new Error("The target file finder failed to load")
console.log(`PASS: native backend libraries on ${process.platform}/${process.arch} with Bun ${process.versions.bun}`)
