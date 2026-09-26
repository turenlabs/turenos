import { describe, expect, test } from "bun:test"
import { SecretRedaction } from "@turenlabs/core/secret-redaction"
import { SecretVault } from "@turenlabs/core/secret-vault"

const github = `ghp_${"a".repeat(36)}`

describe("SecretRedaction", () => {
  test("detects truncated placeholder prefixes before they can be written back", () => {
    const marker = SecretRedaction.text(github)
    expect(SecretRedaction.containsPlaceholder(marker.slice(0, 18))).toBe(true)
    expect(SecretRedaction.containsPlaceholder(`copied ${marker.slice(0, 10)}`)).toBe(true)
  })
  test("preserves optional undefined fields emitted by tool codecs", () => {
    const value = { optional: undefined, nested: [undefined, github] }
    expect(SecretRedaction.json(value)).toEqual({
      optional: undefined,
      nested: [undefined, SecretRedaction.text(github)],
    })
    expect(SecretRedaction.json(undefined)).toBeUndefined()
  })
  test("accepts bounded per-call literal secrets without retaining or rewriting placeholders", () => {
    const secret = "synthetic.password+[literal]"
    const marker = `[SECRET:v1:known:${SecretVault.fingerprint("secret-redaction:v1", secret).slice(0, 32)}]`
    expect(SecretRedaction.text(`prefix ${secret} suffix ${secret}`, [secret])).toBe(
      `prefix ${marker} suffix ${marker}`,
    )
    expect(SecretRedaction.text(secret)).toBe(secret)
    expect(SecretRedaction.text(github, [github])).toBe(SecretRedaction.text(github))
    const shorter = "synthetic-shorter-9Qx"
    const longer = `${shorter}-longer-Z3`
    expect(SecretRedaction.text(`${longer} ${shorter}`, [shorter, longer])).toBe(
      `${SecretRedaction.text(longer, [longer])} ${SecretRedaction.text(shorter, [shorter])}`,
    )
    expect(SecretRedaction.text(longer, [longer])).not.toBe(SecretRedaction.text(shorter, [shorter]))
    expect(SecretRedaction.text(marker, [secret, "SECRET", "known", "a", marker])).toBe(marker)
    expect(SecretRedaction.json({ [secret]: [secret] }, [secret])).toEqual({ [marker]: [marker] })
    expect(SecretRedaction.json(["one", "two"], ["0", "1"])).toEqual(["one", "two"])
    expect(SecretRedaction.text("ok", [""])).toBe("ok")
  })

  test("rejects excess known-value and expanded output budgets without echoing input", () => {
    expect(() => {
      SecretRedaction.text("ok", Array(257).fill("secret"))
    }).toThrow("Secret redaction failed")
    expect(() => {
      SecretRedaction.json("ok", ["s".repeat(65_537)])
    }).toThrow("Secret redaction failed")
    // Each 14-byte value becomes a 50-byte reference, so ~40% of the input budget overflows the output.
    const literal = "q7W-e9R-t1Y-u3"
    expect(() => {
      SecretRedaction.text(`${literal} `.repeat(SecretRedaction.MAX_BYTES / 40), [literal])
    }).toThrow("Secret redaction failed")
  })

  test("detects placeholders in nested keys and values conservatively", () => {
    const marker = SecretRedaction.text(github)
    expect(SecretRedaction.containsPlaceholder({ nested: [{ [marker]: "ok" }] })).toBe(true)
    expect(SecretRedaction.containsPlaceholder({ nested: [marker] })).toBe(true)
    expect(SecretRedaction.containsPlaceholder({ nested: [github, "[SECRET:v2:github:no]", null, 1] })).toBe(false)
    expect(SecretRedaction.containsPlaceholder(`[SECRET:v1:known:${"0".repeat(32)}]`)).toBe(true)
  })

  test("fails closed on bounded text and traversal limits", () => {
    expect(() => SecretRedaction.text("x".repeat(SecretRedaction.MAX_BYTES + 1))).toThrow("Secret redaction failed")
    expect(() =>
      SecretRedaction.json(["x".repeat(SecretRedaction.MAX_BYTES / 2), "y".repeat(SecretRedaction.MAX_BYTES / 2 + 1)]),
    ).toThrow("Secret redaction failed")
    expect(() => SecretRedaction.json(Array(100_001).fill(null))).toThrow("Secret redaction failed")
    const deep = Array.from({ length: 66 }).reduce<unknown>((value) => [value], "leaf")
    expect(() => SecretRedaction.json(deep)).toThrow("Secret redaction failed")
    expect(() => SecretRedaction.containsPlaceholder(deep)).toThrow("Secret redaction failed")
    expect(SecretRedaction.text("x".repeat(SecretRedaction.MAX_BYTES))).toHaveLength(SecretRedaction.MAX_BYTES)
  })

  test("rejects sparse arrays and non-index array properties rather than corrupting them", () => {
    expect(() => SecretRedaction.json(Array(2))).toThrow("Secret redaction failed")
    expect(() => SecretRedaction.json(Object.assign(["ok"], { secret: github }))).toThrow("Secret redaction failed")
    const shared = { value: github }
    expect(SecretRedaction.json([shared, shared])).toEqual([
      { value: SecretRedaction.text(github) },
      { value: SecretRedaction.text(github) },
    ])
  })

  test("rejects sanitized key collisions rather than overwriting values", () => {
    const marker = SecretRedaction.text(github)
    expect(() => SecretRedaction.json({ [github]: "first", [marker]: "second" })).toThrow("Secret redaction failed")
  })

  test("rejects non-JSON objects and getters without leaking their failures", () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const getter = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        throw new Error(github)
      },
    })
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(github)
        },
      },
    )
    for (const value of [cycle, getter, proxy, NaN, Infinity, 1n, new Date(), new Uint8Array([1]), () => github]) {
      expect(() => SecretRedaction.json(value)).toThrow("Secret redaction failed")
      try {
        SecretRedaction.json(value)
      } catch (error) {
        expect(String(error)).not.toContain(github)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).cause).toBeUndefined()
      }
    }
  })

  test("sanitizes nested JSON values and keys without mutation or prototype changes", () => {
    const input = JSON.parse(
      `{"${github}":[{"__proto__":"${github}","constructor":"${github}"},null,true,42],"ordinary":"ok"}`,
    )
    const marker = SecretRedaction.text(github)
    const result = SecretRedaction.json(input)
    expect(result).toEqual(
      JSON.parse(`{"${marker}":[{"__proto__":"${marker}","constructor":"${marker}"},null,true,42],"ordinary":"ok"}`),
    )
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(JSON.stringify(input)).toContain(github)
    expect(SecretRedaction.json(result)).toEqual(result)
  })

  test("redacts complete and truncated PEM private keys without eating complete-block suffixes", () => {
    for (const label of [
      "PRIVATE KEY",
      "RSA PRIVATE KEY",
      "EC PRIVATE KEY",
      "OPENSSH PRIVATE KEY",
      "ENCRYPTED PRIVATE KEY",
      "DSA PRIVATE KEY",
    ]) {
      const block = `-----BEGIN ${label}-----\nsynthetic body\n-----END ${label}-----`
      expect(SecretRedaction.text(`before ${block} after`)).toMatch(
        /^before \[SECRET:v1:pem-private-key:[a-f0-9]{32}\] after$/,
      )
      expect(SecretRedaction.text(`before -----BEGIN ${label}-----\ntruncated body`)).toMatch(
        /^before \[SECRET:v1:pem-private-key:[a-f0-9]{32}\]$/,
      )
      expect(SecretRedaction.text(`-----BEGIN ${label}`)).toMatch(/^\[SECRET:v1:pem-private-key:[a-f0-9]{32}\]$/)
      expect(SecretRedaction.text(`-----BEGIN ${label}---\npartial header and body`)).toMatch(
        /^\[SECRET:v1:pem-private-key:[a-f0-9]{32}\]$/,
      )
    }
    expect(SecretRedaction.text("-----BEGIN PUBLIC KEY-----\npublic\n-----END PUBLIC KEY-----")).toContain("PUBLIC KEY")
  })

  test("recognizes only complete high-confidence provider token shapes", () => {
    const cases = [
      ...["ghp", "gho", "ghu", "ghs", "ghr"].map((prefix) => ["github", `${prefix}_${"a".repeat(36)}`]),
      ["github", `github_pat_${"a".repeat(22)}_${"b".repeat(59)}`],
      ["gitlab", `glpat-${"a".repeat(20)}`],
      ["slack", `xoxb-123456789012-123456789012-${"a".repeat(24)}`],
      ["slack", `xoxp-123456789012-123456789012-123456789012-${"a".repeat(32)}`],
      ["stripe", `sk_live_${"a".repeat(24)}`],
      ["stripe", `rk_live_${"b".repeat(99)}`],
      ["aws-access-key-id", `AKIA${"A".repeat(16)}`],
      ["aws-access-key-id", `ASIA${"B".repeat(16)}`],
      ["google-api-key", `AIza${"a".repeat(35)}`],
    ]
    for (const [rule, token] of cases) {
      expect(SecretRedaction.text(`(${token})`)).toMatch(new RegExp(`^\\(\\[SECRET:v1:${rule}:[a-f0-9]{32}\\]\\)$`))
      expect(SecretRedaction.text(`z${token}`)).toBe(`z${token}`)
      expect(SecretRedaction.text(`${token}_suffix`)).toBe(`${token}_suffix`)
    }
    expect(SecretRedaction.text(`${github}z`)).toBe(`${github}z`)
    expect(SecretRedaction.text(`github_pat_${"a".repeat(22)}_${"b".repeat(60)}`)).toBe(
      `github_pat_${"a".repeat(22)}_${"b".repeat(60)}`,
    )
  })

  test("replaces repeated GitHub credentials with stable keyed placeholders", () => {
    const marker = `[SECRET:v1:github:${SecretVault.fingerprint("secret-redaction:v1", github).slice(0, 32)}]`
    expect(SecretRedaction.text(`before ${github} ${github} after`)).toBe(`before ${marker} ${marker} after`)
    expect(SecretRedaction.text(marker)).toBe(marker)
    expect(SecretRedaction.text("ordinary text and ghp_example")).toBe("ordinary text and ghp_example")
    expect(SecretRedaction.text(`ghp_${"b".repeat(36)}`)).not.toBe(marker)
  })
})

describe("SecretRedaction configured values", () => {
  const aws = `AKIA${"Q7".repeat(8)}`
  const known = (value: string) =>
    `[SECRET:v1:known:${SecretVault.fingerprint("secret-redaction:v1", value).slice(0, 32)}]`

  test("masks a configured value completely when it embeds a recognizable format", () => {
    const composite = `${aws}:wJalr-synthetic/Secret+Access7Key`
    expect(SecretRedaction.text(`credentials=${composite}\n`, [composite])).toBe(`credentials=${known(composite)}\n`)
    const pem = "-----BEGIN PRIVATE KEY-----\nc3ludGhldGlj\n-----END PRIVATE KEY-----"
    const account = `{"client_id":"synthetic-client-4471","private_key":"${pem}"}`
    expect(SecretRedaction.text(`sa=${account}`, [account])).toBe(`sa=${known(account)}`)
  })

  test("masks every configured value when occurrences overlap or sit inside a detected token", () => {
    const first = "synthetic-alpha-7Q2x-bravo"
    const second = "bravo-9Z4k-synthetic-omega"
    const joined = SecretRedaction.text("synthetic-alpha-7Q2x-bravo-9Z4k-synthetic-omega", [first, second])
    for (const fragment of ["7Q2x", "9Z4k", "omega", "alpha"]) expect(joined).not.toContain(fragment)
    expect(joined).toMatch(/^\[SECRET:v1:known:[a-f0-9]{32}\]$/)
    const token = "ghp_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7c"
    const inner = SecretRedaction.text(`use ${token} now`, [token.slice(8, 28)])
    expect(inner).toBe(`use ${SecretRedaction.text(token)} now`)
  })

  test("ignores short, low-variety and well-known placeholder values instead of masking ordinary text", () => {
    const text = "x = max(x, 1); ollama run; OPENAI_API_KEY=sk-no-key-required EMPTY none 0000000000000000"
    const dummies = ["x", "ollama", "sk-no-key-required", "EMPTY", "none", "0000000000000000", "abababababababab"]
    expect(SecretRedaction.text(text, dummies)).toBe(text)
    expect(SecretRedaction.json({ text }, dummies)).toEqual({ text })
    for (const dummy of dummies) expect(SecretRedaction.eligible(dummy)).toBe(false)
    for (const real of ["opaque.cobalt.river.42", "synthetic-private-extension-credential-92837"])
      expect(SecretRedaction.eligible(real)).toBe(true)
  })

  test("stream boundaries never split a finding and hold an unterminated private key", () => {
    const compiled = SecretRedaction.compile(["synthetic-opaque-9QxW-7741"])
    const token = `ghp_${"Tb5".repeat(12)}`
    const filler = "x ".repeat(4000)
    expect(compiled.boundary("short")).toBe(0)
    // A token straddling the default release point moves the cut to the token's start.
    const straddling = `${filler}${token} ${"y ".repeat(2046)}`
    const start = straddling.indexOf(token)
    expect(straddling.length - 4096).toBeGreaterThan(start)
    expect(straddling.length - 4096).toBeLessThan(start + token.length)
    expect(compiled.boundary(straddling)).toBe(start)
    // An open private key block is held from its header.
    const open = `${filler}-----BEGIN PRIVATE KEY-----\nc3ludGhldGlj${"y".repeat(8000)}`
    expect(compiled.boundary(open)).toBe(open.indexOf("-----BEGIN"))
    // Releasing prefixes at every boundary reproduces one-shot redaction.
    const text = `${filler}${token} key synthetic-opaque-9QxW-7741 ${filler}${token}\n${filler}`
    let pending = ""
    let released = ""
    for (const chunk of text.match(/[\s\S]{1,997}/g)!) {
      pending += chunk
      const cut = compiled.boundary(pending)
      released += compiled.text(pending.slice(0, cut))
      pending = pending.slice(cut)
    }
    released += compiled.text(pending)
    expect(released).toBe(compiled.text(text))
  })

  test("compiled snapshots match one-shot redaction and never mask ineligible values", () => {
    const secrets = ["synthetic-opaque-9QxW-7741", "ollama"]
    const compiled = SecretRedaction.compile(secrets)
    const text = `ollama uses synthetic-opaque-9QxW-7741 and ${github}`
    expect(compiled.text(text)).toBe(SecretRedaction.text(text, secrets))
    expect(compiled.text(text)).toContain("ollama uses [SECRET:v1:known:")
    expect(compiled.json({ [text]: [text] })).toEqual(SecretRedaction.json({ [text]: [text] }, secrets))
  })
})
