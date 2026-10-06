import { generateKeyPairSync, sign } from "node:crypto"

export const encode = (value) =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url")
export function fixture(algorithm = "ES256") {
  const keys =
    algorithm === "RS256"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const jwk = {
    ...keys.publicKey.export({ format: "jwk" }),
    alg: algorithm,
    kid: "test-key",
    use: "sig",
    key_ops: ["verify"],
  }
  const policy = { algorithm, issuer: "https://identity.example", audience: "payments-api", now: 1800000000 }
  const claims = {
    iss: policy.issuer,
    aud: policy.audience,
    exp: policy.now + 300,
    nbf: policy.now,
    iat: policy.now,
    sub: "DO-NOT-REPORT-SUBJECT",
  }
  const header = { alg: algorithm, typ: "JWT", kid: jwk.kid }
  const token = (payload = claims, protectedHeader = header, der = false) => {
    const signed = `${encode(protectedHeader)}.${encode(payload)}`
    const signature = sign(
      "sha256",
      Buffer.from(signed),
      algorithm === "ES256" ? { key: keys.privateKey, dsaEncoding: der ? "der" : "ieee-p1363" } : keys.privateKey,
    )
    return Buffer.from(`${signed}.${signature.toString("base64url")}`)
  }
  return { keys, jwk, policy, claims, header, token }
}
