export const Language = {
  TypeScript: "typescript",
  Python: "python",
  JavaScript: "javascript",
  Java: "java",
  CSharp: "csharp",
  PHP: "php",
  Shell: "shell",
  CPP: "cpp",
  HCL: "hcl",
  Go: "go",
} as const

export type Language = (typeof Language)[keyof typeof Language]

export type LanguageSupport = {
  language: Language
  rank: number
  extensions: string[]
  tier: "semantic-expression" | "dependency" | "dependency-expression"
}

export const MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024

const topLanguageSupport: readonly LanguageSupport[] = [
  {
    language: Language.TypeScript,
    rank: 1,
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    tier: "semantic-expression",
  },
  {
    language: Language.Python,
    rank: 2,
    extensions: [".py", ".pyi"],
    tier: "semantic-expression",
  },
  {
    language: Language.JavaScript,
    rank: 3,
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    tier: "semantic-expression",
  },
  { language: Language.Java, rank: 4, extensions: [".java"], tier: "semantic-expression" },
  { language: Language.CSharp, rank: 5, extensions: [".cs"], tier: "semantic-expression" },
  {
    language: Language.PHP,
    rank: 6,
    extensions: [".php", ".phtml"],
    tier: "semantic-expression",
  },
  {
    language: Language.Shell,
    rank: 7,
    extensions: [".sh", ".bash", ".zsh", ".ksh"],
    tier: "dependency",
  },
  {
    language: Language.CPP,
    rank: 8,
    extensions: [".cpp", ".cc", ".cxx", ".c++", ".hpp", ".hh", ".hxx", ".h", ".c"],
    tier: "semantic-expression",
  },
  {
    language: Language.HCL,
    rank: 9,
    extensions: [".tf", ".hcl", ".tfvars"],
    tier: "dependency-expression",
  },
  { language: Language.Go, rank: 10, extensions: [".go"], tier: "semantic-expression" },
]

const extensionLanguage = new Map(
  topLanguageSupport.flatMap((support) =>
    support.extensions.map((extension) => [extension, support.language] as const),
  ),
)
const unsupportedSourceExtensions = new Set([
  ".dart",
  ".ex",
  ".exs",
  ".kt",
  ".kts",
  ".lua",
  ".m",
  ".mm",
  ".r",
  ".rb",
  ".rs",
  ".scala",
  ".sql",
  ".swift",
])

const skippedIndexDirectories = new Set([
  ".git",
  ".hg",
  ".svn",
  ".batou",
  ".case",
  ".forge",
  ".perf",
  ".turbo",
  ".worktrees",
  "vendor",
  "node_modules",
  "target",
  "build",
  "dist",
  "out",
  "bin",
  "obj",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".terraform",
  "coverage",
  ".cache",
  ".idea",
  ".gradle",
  "generated",
  "storybook-static",
])

export function supportedLanguages(): LanguageSupport[] {
  return topLanguageSupport.map((support) => ({ ...support, extensions: [...support.extensions] }))
}

export function detectLanguage(path: string, source: string | Uint8Array = ""): Language | undefined {
  const extension = fileExtension(path).toLowerCase()
  const detected = extensionLanguage.get(extension)
  if (detected) return detected
  if (extension !== "") return

  const firstLine = (typeof source === "string" ? source : new TextDecoder().decode(source))
    .split("\n", 1)[0]!
    .toLowerCase()
  if (!firstLine.startsWith("#!")) return
  if (["bash", "sh", "zsh", "ksh"].some((shell) => firstLine.includes(shell))) return Language.Shell
}

export function shouldSkipIndexDir(name: string): boolean {
  const normalized = name.toLowerCase()
  return (
    skippedIndexDirectories.has(normalized) ||
    normalized.startsWith("generated-") ||
    normalized.startsWith("generated_")
  )
}

export const shouldSkipIndexDirectory = shouldSkipIndexDir

export function shouldSkipIndexPath(value: string) {
  const name = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1).toLowerCase()
  return (
    name === "generated.ts" ||
    name === "generated.js" ||
    name.includes(".generated.") ||
    name.includes(".gen.") ||
    /_generated\.[^.]+$/.test(name) ||
    /^(?:chunk|node)-[a-z0-9_-]{8,}\.(?:c?js|mjs)$/.test(name)
  )
}

export function isKnownUnsupportedSourcePath(value: string) {
  return unsupportedSourceExtensions.has(fileExtension(value).toLowerCase())
}

export function shouldSkipIndexFile(path: string, source: string | Uint8Array): boolean {
  const size = typeof source === "string" ? new TextEncoder().encode(source).byteLength : source.byteLength
  return shouldSkipIndexPath(path) || size > MAX_SOURCE_FILE_BYTES || detectLanguage(path, source) === undefined
}

export function pathModule(root: string, path: string, language: Language): string {
  const relative = relativePath(root, path).replaceAll("\\", "/")
  const withoutExtension = trimSuffix(relative, fileExtension(relative))
  const modulePath = language === Language.HCL ? portableDirname(relative) : trimIndexModule(withoutExtension, language)

  if (language === Language.HCL && (modulePath === "." || modulePath === "")) return "hcl"

  const parts = modulePath
    .split(/[\\/.\-]+/)
    .filter(Boolean)
    .map(cleanModuleSegment)
  if (parts.length === 0) return language
  return parts.join(".")
}

export function languagePrefix(language: Language): string {
  switch (language) {
    case Language.TypeScript:
      return "ts"
    case Language.JavaScript:
      return "js"
    case Language.Python:
      return "py"
    case Language.Java:
      return "java"
    case Language.CSharp:
      return "csharp"
    case Language.PHP:
      return "php"
    case Language.Shell:
      return "shell"
    case Language.CPP:
      return "cpp"
    case Language.HCL:
      return "hcl"
    case Language.Go:
      return "go"
  }
  return language
}

export function languageNames(counts: ReadonlyMap<Language, number>): string[] {
  return [...counts.keys()].sort()
}

function cleanModuleSegment(segment: string) {
  const cleaned = segment.replaceAll(/[^A-Za-z0-9_]+/g, "_").replaceAll(/^_+|_+$/g, "")
  return cleaned || "root"
}

function fileExtension(path: string) {
  const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1)
  const dot = base.lastIndexOf(".")
  return dot < 0 ? "" : base.slice(dot)
}

function portableDirname(path: string) {
  const slash = path.lastIndexOf("/")
  if (slash < 0) return "."
  if (slash === 0) return "/"
  return path.slice(0, slash)
}

function trimSuffix(value: string, suffix: string) {
  if (!suffix || !value.endsWith(suffix)) return value
  return value.slice(0, -suffix.length)
}

function trimIndexModule(path: string, language: Language) {
  if (
    (language === Language.TypeScript || language === Language.JavaScript || language === Language.Python) &&
    path.endsWith("/index")
  ) {
    return path.slice(0, -"/index".length)
  }
  return path
}

function relativePath(root: string, path: string) {
  const normalizedRoot = cleanPath(root)
  const normalizedPath = cleanPath(path)
  if (normalizedRoot === normalizedPath) return "."
  if (normalizedPath.startsWith(normalizedRoot.endsWith("/") ? normalizedRoot : normalizedRoot + "/")) {
    return normalizedPath.slice(normalizedRoot.length).replace(/^\/+/, "")
  }

  const rootParts = normalizedRoot.split("/").filter(Boolean)
  const pathParts = normalizedPath.split("/").filter(Boolean)
  const rootVolume = /^[A-Za-z]:/.exec(normalizedRoot)?.[0]?.toLowerCase()
  const pathVolume = /^[A-Za-z]:/.exec(normalizedPath)?.[0]?.toLowerCase()
  if (rootVolume !== pathVolume) return pathParts.at(-1) ?? normalizedPath

  const common = rootParts.findIndex((part, index) => part !== pathParts[index])
  const shared = common < 0 ? Math.min(rootParts.length, pathParts.length) : common
  return [...rootParts.slice(shared).map(() => ".."), ...pathParts.slice(shared)].join("/") || "."
}

function cleanPath(path: string) {
  const prefix = path.startsWith("/") ? "/" : ""
  const parts = path
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .reduce<string[]>((result, part) => {
      if (part === ".." && result.length > 0 && result.at(-1) !== "..") return result.slice(0, -1)
      return [...result, part]
    }, [])
  return prefix + parts.join("/")
}
