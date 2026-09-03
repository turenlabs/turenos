import os from "os"
import path from "path"

const home = os.homedir()

const DARWIN_HOME = [
  "Music",
  "Pictures",
  "Movies",
  "Downloads",
  "Desktop",
  "Documents",
  "Public",
  "Applications",
  "Library",
]

const DARWIN_LIBRARY = [
  "Application Support/AddressBook",
  "Calendars",
  "Mail",
  "Messages",
  "Safari",
  "Cookies",
  "Application Support/com.apple.TCC",
  "PersonalizationPortrait",
  "Metadata/CoreSpotlight",
  "Suggestions",
]

const DARWIN_ROOT = ["/.DocumentRevisions-V100", "/.Spotlight-V100", "/.Trashes", "/.fseventsd"]
const WIN32_HOME = ["AppData", "Downloads", "Desktop", "Documents", "Pictures", "Music", "Videos", "OneDrive"]

/**
 * Whether `dir` is the home directory itself.
 *
 * The basenames below are only protected where macOS actually protects them —
 * directly under home. A project of your own called `Documents` is an ordinary
 * folder and must stay browsable.
 */
export function isHome(dir: string): boolean {
  if (!home) return false
  return path.resolve(dir) === path.resolve(home)
}

/** Directory basenames to skip when scanning the home directory. */
export function names(): ReadonlySet<string> {
  if (process.platform === "darwin") return new Set(DARWIN_HOME)
  if (process.platform === "win32") return new Set(WIN32_HOME)
  return new Set()
}

/**
 * Protected paths that live under `dir`, as relative paths. Non-empty only for
 * roots that contain TCC-protected folders (in practice, the home directory) —
 * scanners must skip these or macOS raises a consent prompt per category.
 */
export function under(dir: string): string[] {
  return paths().flatMap((item) => {
    const relative = path.relative(dir, item)
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return []
    return [relative.replaceAll("\\", "/")]
  })
}

/** Absolute paths that should never be watched, stated, or scanned. */
export function paths(): string[] {
  if (process.platform === "darwin")
    return [
      ...DARWIN_HOME.map((name) => path.join(home, name)),
      ...DARWIN_LIBRARY.map((name) => path.join(home, "Library", name)),
      ...DARWIN_ROOT,
    ]
  if (process.platform === "win32") return WIN32_HOME.map((name) => path.join(home, name))
  return []
}

export * as Protected from "./protected"
