import { describe, expect, test } from "bun:test"
import {
  controlPath,
  detectSshPrompt,
  localPlatformTarget,
  parseRemoteProbe,
  parseSshConfig,
  parseSshTarget,
  remotePlatformTarget,
  sshDestination,
  sshTargetId,
  summarizeSshOutput,
} from "./runtime"
import { parseRemoteState, remoteInstallMissing } from "./shim"

describe("parseSshTarget", () => {
  test("parses plain host", () => {
    expect(parseSshTarget("example.com")).toEqual({ user: null, host: "example.com", port: null })
  })

  test("parses user@host", () => {
    expect(parseSshTarget("deploy@example.com")).toEqual({ user: "deploy", host: "example.com", port: null })
  })

  test("parses host:port and user@host:port", () => {
    expect(parseSshTarget("example.com:2222")).toEqual({ user: null, host: "example.com", port: 2222 })
    expect(parseSshTarget("deploy@example.com:2222")).toEqual({ user: "deploy", host: "example.com", port: 2222 })
  })

  test("accepts ssh config aliases", () => {
    expect(parseSshTarget("prod-web")).toEqual({ user: null, host: "prod-web", port: null })
  })

  test("rejects empty, whitespace, and option-injection inputs", () => {
    expect(parseSshTarget("")).toBeNull()
    expect(parseSshTarget("  ")).toBeNull()
    expect(parseSshTarget("-o ProxyCommand=evil")).toBeNull()
    expect(parseSshTarget("host name")).toBeNull()
    expect(parseSshTarget("@-malicious")).toBeNull()
  })

  test("rejects invalid ports", () => {
    expect(parseSshTarget("host:0")).toBeNull()
    expect(parseSshTarget("host:99999")).toBeNull()
    expect(parseSshTarget("host:abc")).toBeNull()
  })
})

describe("sshTargetId", () => {
  test("omits the default port so aliases and explicit :22 dedupe", () => {
    expect(sshTargetId({ hostname: "example.com", user: "me", port: 22 })).toBe("ssh:me@example.com")
    expect(sshTargetId({ hostname: "example.com", user: "me", port: 2222 })).toBe("ssh:me@example.com:2222")
  })
})

describe("sshDestination", () => {
  test("reconstructs user@host", () => {
    expect(sshDestination({ host: "example.com", user: "me" })).toBe("me@example.com")
    expect(sshDestination({ host: "example.com", user: null })).toBe("example.com")
  })
})

describe("detectSshPrompt", () => {
  test("detects password prompts", () => {
    const prompt = detectSshPrompt("debug output\r\nuser@host's password: ")
    expect(prompt).not.toBeNull()
    expect(prompt!.kind).toBe("password")
    expect(detectSshPrompt("user@host's password:\r")).toEqual({
      kind: "password",
      message: "user@host's password:",
    })
  })

  test("detects passphrase prompts", () => {
    const prompt = detectSshPrompt("Enter passphrase for key '/home/me/.ssh/id_ed25519': ")
    expect(prompt).not.toBeNull()
    expect(prompt!.kind).toBe("passphrase")
  })

  test("detects host-key confirmation and keeps the fingerprint context", () => {
    const tail = [
      "The authenticity of host 'example.com (1.2.3.4)' can't be established.",
      "ED25519 key fingerprint is SHA256:abcdef.",
      "This key is not known by any other names.",
      "Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
    ].join("\r\n")
    const prompt = detectSshPrompt(tail)
    expect(prompt).not.toBeNull()
    expect(prompt!.kind).toBe("hostkey")
    expect(prompt!.message).toContain("SHA256:abcdef")
  })

  test("detects keyboard-interactive OTP and smartcard PIN prompts", () => {
    expect(detectSshPrompt("Verification code: ")).toEqual({
      kind: "password",
      message: "Verification code:",
    })
    expect(detectSshPrompt("(me@host) Duo two-factor passcode: ")).toMatchObject({ kind: "password" })
    expect(detectSshPrompt("Enter PIN for 'PIV Card': ")).toMatchObject({ kind: "password" })
  })

  test("does not misfire on ordinary output", () => {
    expect(detectSshPrompt("normal output\nstill going\n")).toBeNull()
    expect(detectSshPrompt("")).toBeNull()
    // A password string mid-line is not a prompt - only a trailing "password:" is.
    expect(detectSshPrompt("log line about password handling\nnext line\n")).toBeNull()
  })
})

describe("parseSshConfig", () => {
  test("extracts hostname, user, port, identityfile from ssh -G output", () => {
    const config = parseSshConfig(
      [
        "user deploy",
        "hostname 203.0.113.9",
        "port 2222",
        "identityfile ~/.ssh/id_ed25519",
        "identityfile ~/.ssh/id_rsa",
        "addkeystoagent false",
      ].join("\n"),
    )
    expect(config.hostname).toBe("203.0.113.9")
    expect(config.user).toBe("deploy")
    expect(config.port).toBe(2222)
    // First identityfile wins (ssh -G lists all configured files)
    expect(config.identityfile).toContain(".ssh/id_ed25519")
  })
})

describe("remote probe parsing", () => {
  test("parseRemoteProbe extracts fields", () => {
    const probe = parseRemoteProbe(
      "FORGE_PROBE platform=Linux-x86_64\nFORGE_PROBE bash=1\nFORGE_PROBE curl=1\nFORGE_PROBE forge_path=/home/u/.forge/bin/forge\nFORGE_PROBE forge_version=1.16.2\n",
    )
    expect(probe).toEqual({
      platform: "Linux-x86_64",
      hasBash: true,
      hasCurl: true,
      forgePath: "/home/u/.forge/bin/forge",
      forgeVersion: "1.16.2",
    })
  })

  test("parseRemoteProbe handles a bare remote", () => {
    const probe = parseRemoteProbe("FORGE_PROBE platform=Darwin-arm64\n")
    expect(probe.platform).toBe("Darwin-arm64")
    expect(probe.hasBash).toBe(false)
    expect(probe.forgePath).toBeNull()
  })

  test("parseRemoteProbe ignores key=value noise from MOTD and profile output", () => {
    const motd = "Last login: Thu\nplatform=spoofed\nforge_version=99.0\nWelcome!\nFORGE_PROBE platform=Linux-x86_64\n"
    const probe = parseRemoteProbe(motd)
    expect(probe.platform).toBe("Linux-x86_64")
    expect(probe.forgeVersion).toBeNull()
  })
})

describe("platform targets", () => {
  test("remotePlatformTarget maps uname to release targets", () => {
    expect(remotePlatformTarget("Linux-x86_64")).toBe("linux-x64")
    expect(remotePlatformTarget("Linux-aarch64")).toBe("linux-arm64")
    expect(remotePlatformTarget("Darwin-arm64")).toBe("darwin-arm64")
    expect(remotePlatformTarget(null)).toBeNull()
    expect(remotePlatformTarget("FreeBSD-amd64")).toBeNull()
  })

  test("localPlatformTarget returns a target string", () => {
    expect(localPlatformTarget()).toContain(process.platform)
  })
})

describe("controlPath", () => {
  test("is deterministic per target and stays short for socket limits", () => {
    const a = controlPath("/tmp/ctl", { host: "h", user: "u", port: 22, identityFile: null })
    const b = controlPath("/tmp/ctl", { host: "h", user: "u", port: 22, identityFile: null })
    const c = controlPath("/tmp/ctl", { host: "h", user: "other", port: 22, identityFile: null })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.length).toBeLessThan(104)
  })
})

describe("summarizeSshOutput", () => {
  test("keeps the tail and drops empty lines", () => {
    expect(summarizeSshOutput("a\n\nb\nc")).toBe("a b c")
    expect(summarizeSshOutput("")).toBe("")
  })

  test("filters benign ssh stderr noise", () => {
    const noisy = [
      "identity file /u/.ssh/id_rsa not accessible: No such file or directory",
      "identity file /u/.ssh/id_ed25519 not accessible: No such file or directory",
      "Warning: Permanently added 'example.com' (ED25519) to the list of known hosts.",
      "ssh: connect to host example.com port 22: Operation timed out",
    ].join("\n")
    expect(summarizeSshOutput(noisy)).toBe("ssh: connect to host example.com port 22: Operation timed out")
    expect(summarizeSshOutput("identity file /u/.ssh/id_rsa not accessible: No such file")).toBe("")
  })
})

describe("remote state parsing", () => {
  test("parseRemoteState reads the FORGE_REMOTE line", () => {
    const output = 'noise\nFORGE_REMOTE {"port":4096,"username":"forge","password":"s3cret"}\n'
    expect(parseRemoteState(output)).toEqual({ port: 4096, username: "forge", password: "s3cret" })
  })

  test("parseRemoteState rejects malformed or missing state", () => {
    expect(parseRemoteState("nothing here")).toBeNull()
    expect(parseRemoteState("FORGE_REMOTE {not json}")).toBeNull()
    expect(parseRemoteState('FORGE_REMOTE {"port":"4096","username":"forge","password":"x"}')).toBeNull()
  })

  test("remoteInstallMissing detects the shim's missing-forge sentinel", () => {
    expect(remoteInstallMissing("FORGE_REMOTE_ERROR forge is not installed")).toBe(true)
    expect(remoteInstallMissing("other failure")).toBe(false)
  })
})
