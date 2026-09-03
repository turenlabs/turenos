// Taxonomy for forge-scan.
//
// This file is the heart of the auto-discovery. Each pattern is a lightweight
// matcher against the callee identifier of a CallExpression (plus optional
// module origin and an argument-index whitelist). The engine walks every source
// file and classifies occurrences into one of three roles:
//
//   sources     -- untrusted/derived data can enter the program here
//   sinks       -- data can escape / have effect here (exec, files, network, db)
//   sanitizers  -- a transform or gate that reduces the risk of a value
//
// Patterns are NAME-LEVEL by design. They are cheap, transparent, and easy to
// extend by hand, but the point is that the "new ones" are ADDED BY THE SCAN
// itself: any callee, source handler parameter, or import that the taxonomy
// does not recognize above a confidence threshold is surfaced as an "emergent"
// entry the developer may promote into production taxonomy.

export type Role = "source" | "sink" | "sanitizer"

export interface Pattern {
  // Stable identity used in the committed catalog (its value must not drift
  // just because line numbers move).
  id: string
  role: Role
  // Matched callee identifier forms, e.g. ["writeFile", "Bun.write"].
  callee: string[]
  // Human classification, e.g. "filesystem".
  category: string
  // Optional origins the callee typically comes from (import specifiers).
  module?: string[]
  // Confidence 0..1. Patterns above 0.9 are firm; lower needs a review pass.
  confidence: number
  // Whole files matching this regex are promoted to source scope, e.g. any
  // HttpApi handler group is a user-input boundary.
  fileScope?: RegExp
}

export const PRODUCTION: Pattern[] = [
  // ---- SINKS ---------------------------------------------------------------
  {
    id: "syscall.exec",
    role: "sink",
    matches: ["exec", "execFile", "execSync", "execFileSync", "spawn", "spawnSync"],
    category: "process",
    module: ["cross-spawn", "child_process", "node:child_process"],
    confidence: 0.96,
  },
  {
    id: "fs.write",
    role: "sink",
    matches: [
      "writeFile",
      "writeFileSync",
      "appendFile",
      "appendFileSync",
      "write",
      "writeSync",
      "createWriteStream",
      "mkdtemp",
      "mkdirSync",
      "Bun.write",
      "copyFile",
      "rename",
    ],
    category: "filesystem",
    module: ["fs", "node:fs", "bun:fs"],
    confidence: 0.93,
  },
  {
    id: "net.request",
    role: "sink",
    matches: ["fetch", "request", "delete", "patch", "post", "put", "get"],
    category: "network",
    module: ["node-fetch", "undici", "axios", "got", "superagent"],
    confidence: 0.85,
  },
  {
    id: "db.query",
    role: "sink",
    matches: ["execute", "executeSync", "query", "raw", "run", "all"],
    category: "database",
    module: ["@libsql/client", "@effect/sql", "better-sqlite3", "drizzle-orm"],
    confidence: 0.8,
  },
  {
    id: "code.eval",
    role: "sink",
    matches: ["eval", "Function"],
    category: "eval",
    module: [],
    confidence: 0.98,
  },

  // SOURCES ----------------------------------------------------------------
  {
    id: "http.httproute",
    role: "source",
    matches: ["HttpApiBuilder", "HttpApi", "http"],
    category: "http",
    module: ["effect/unstable/httpapi", "effect/http"],
    confidence: 0.6,
    fileScope: /HttpApi|Endpoint|Api\(/,
  },
  {
    id: "process.args",
    role: "source",
    matches: ["argv"],
    category: "process",
    module: [],
    confidence: 0.9,
  },
  {
    id: "process.env",
    role: "source",
    matches: ["env"],
    category: "process",
    module: [],
    confidence: 0.9,
  },
  {
    id: "io.stdin",
    role: "source",
    matches: ["stdin", "readAll", "read"],
    category: "process",
    module: ["node:readline", "bun:stream"],
    confidence: 0.7,
  },
  {
    id: "plugin.config",
    role: "source",
    matches: ["read", "load", "fromConfig", "parse"],
    category: "configuration",
    module: ["../config", "./config"],
    confidence: 0.55,
  },

  // SANITIZERS -------------------------------------------------------------
  {
    id: "validate.schema",
    role: "sanitizer",
    matches: [
      "decodeUnknown",
      "decodeUnknownSync",
      "decode",
      "decodeSync",
      "parse",
      "parseSync",
      "safeParse",
      "validate",
      "Validate",
    ],
    category: "validation",
    module: ["@effect/schema", "zod", "zod/v3"],
    confidence: 0.9,
  },
  {
    id: "auth.permission",
    role: "sanitizer",
    matches: ["requirePermission", "Authorize", "checkPermission", "authorize", "authoriz", "denyUnless"],
    category: "authorization",
    module: [],
    confidence: 0.85,
  },
  {
    id: "path.sandbox",
    role: "sanitizer",
    matches: ["basename", "relative", "isWithin", "normalize", "resolve"],
    category: "path",
    module: ["node:path", "path"],
    confidence: 0.6,
  },
]
