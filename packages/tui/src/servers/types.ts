/**
 * Every TurenOS server this client can reach. Local servers are discovered from the records their
 * owners publish (the desktop's attach.json, the quick-connect shim's ~/.forge/run, the persistent
 * server's /etc/turenos/attach.json); remote servers are saved here or imported from the desktop.
 * Nothing in this module stores a password on disk.
 */
export type Target =
  | { kind: "desktop"; id: string; name: string; record: string }
  | { kind: "shim"; id: "shim"; name: string }
  | { kind: "persistent"; id: "persistent"; name: string }
  | { kind: "env"; id: "env"; name: string; url: string }
  | { kind: "headless"; id: "headless"; name: string; binary: string }
  | { kind: "url"; id: string; name: string; url: string; username?: string; passwordEnv?: string; saved: boolean }
  | SshTarget

export type SshTarget = {
  kind: "ssh"
  id: string
  name: string
  host: string
  user?: string
  port?: number
  identityFile?: string
  saved: boolean
  desktop: boolean
}

export type Group = "Opened this session" | "This computer" | "Saved" | "From TurenOS Desktop"
/** `url` is the endpoint a local entry stands for, so the picker can tell it is the one already connected. */
export type Entry = { target: Target; group: Group; detail: string; url?: string }

export type Endpoint = {
  target: Target
  url: string
  username: string
  password?: string
  version?: string
  /** Releases what this client opened for the endpoint, such as an SSH tunnel. */
  close?: () => void
}

/** The server rejected the credentials this client has; the caller may ask for a password and retry. */
export class PasswordRequired extends Error {
  constructor(readonly target: Target) {
    super(`${target.name} needs a password.`)
    this.name = "PasswordRequired"
  }
}

export type Options = {
  env?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
  uid?: number
  /** Saved servers; defaults to $XDG_CONFIG_HOME/turen-tui/servers.json. */
  config?: string
  ssh?: string
  /** Overrides forge CLI discovery; null disables the headless server. */
  forge?: string | null
  persistentRecord?: string
  username?: string
  /** Reads a /proc file as text; undefined when it cannot be read. An absent tcp6 table (no IPv6) reads as "". */
  readProc?: (path: string) => string | undefined
}

/** A server's address and credentials as published by its owner. */
export type AttachRecord = {
  url: string
  username: string
  password: string
  /** The identity its owner published; a server that names a different one is not the record's owner. */
  serverID?: string
}

/** The resolved, read-only environment every servers operation runs against. */
export type Context = {
  env: NodeJS.ProcessEnv
  home: string
  platform: NodeJS.Platform
  uid: number | undefined
  configPath: string
  ssh: string
  persistentPath: string
  forge: string | null | undefined
  username: string | undefined
  readProc: (path: string) => string | undefined
}

export type PrivateServer = { child: ReturnType<typeof Bun.spawn>; url: string; password: string }

/** What one `createServers` instance remembers between calls. */
export type State = {
  passwords: Map<string, string>
  saved: Extract<Target, { kind: "url" | "ssh" }>[]
  problems: string[]
  notes: string[]
  /** Why saved servers cannot be written, when the file on disk could not be fully read. */
  unwritable: string | undefined
  /** Saved entries this version cannot read, written back unchanged. */
  preserved: unknown[]
  imported: SshTarget[]
  headless: PrivateServer | undefined
}
