import { Extension } from "@turenlabs/schema"

export function validateManifestPolicy(manifest: Extension.Manifest) {
  if (manifest.contributions.length === 0) throw new Error(`Extension requires a contribution in ${manifest.id}`)
  if (
    manifest.contributions.length > 1 &&
    manifest.contributions.some(
      (contribution) => contribution.type !== "mcp" || contribution.adapter !== `mcp:${contribution.id}`,
    )
  ) {
    throw new Error(`Multi-contribution extensions require generic MCP contributions in ${manifest.id}`)
  }
  if (manifest.trust === "official" && !manifest.id.startsWith("turenlabs/")) {
    throw new Error(`Only the turenlabs namespace can declare official trust: ${manifest.id}`)
  }

  const contributionIDs = new Set<string>()
  for (const contribution of manifest.contributions) {
    if (contributionIDs.has(contribution.id)) {
      throw new Error(`Duplicate contribution id in ${manifest.id}: ${contribution.id}`)
    }
    contributionIDs.add(contribution.id)

    const secretIDs = new Set<string>()
    for (const secret of contribution.secrets) {
      if (secretIDs.has(secret.id)) throw new Error(`Duplicate secret in ${manifest.id}: ${secret.id}`)
      secretIDs.add(secret.id)
    }
    if (
      contribution.secrets.length &&
      !contribution.adapter.startsWith("security:") &&
      !contribution.adapter.startsWith("websearch:") &&
      !contribution.adapter.startsWith("provider:") &&
      !(manifest.trust === "official" && contribution.type === "mcp")
    ) {
      throw new Error(`Extension ${manifest.id} requires an audited secret adapter`)
    }

    if (contribution.type === "tool" || contribution.type === "data" || contribution.type === "mcp") {
      validateToolPolicy(manifest, contribution)
    }
    if (contribution.type === "data" && contribution.tools.write.length > 0) {
      throw new Error(`Data contribution tools must be read-only in ${manifest.id}`)
    }

    if (contribution.type === "tool" || contribution.type === "mcp") {
      const configuration = new Set<string>()
      for (const field of contribution.configuration ?? []) {
        if (configuration.has(field.id)) {
          throw new Error(`Duplicate configuration field in ${manifest.id}: ${field.id}`)
        }
        configuration.add(field.id)
      }
    }

    if (contribution.type === "tool") {
      const commands = new Set<string>()
      for (const command of contribution.commands) {
        if (!command || command.trim() !== command || command.includes("\0")) {
          throw new Error(`Invalid executable declaration in ${manifest.id}`)
        }
        if (commands.has(command)) throw new Error(`Duplicate executable declaration in ${manifest.id}: ${command}`)
        commands.add(command)
      }
    }

    if (contribution.type === "skill") {
      validateSkillPolicy(manifest, contribution)
      if (manifest.trust !== "official" && contribution.source.type !== "catalog") {
        throw new Error(`${manifest.trust} extension ${manifest.id} must embed prompt-only catalog skill content`)
      }
      continue
    }

    if (contribution.type !== "mcp") {
      if (manifest.trust !== "official") {
        throw new Error(
          `${manifest.trust} extension ${manifest.id} cannot select a privileged ${contribution.type} adapter`,
        )
      }
      continue
    }

    if (contribution.upstreamPolicy === "audited-linear-dynamic-v1") {
      validateLinearDynamicPolicy(manifest, contribution)
    } else if (manifest.id === "turenlabs/linear") {
      throw new Error("Linear must use its audited dynamic upstream policy")
    }
    validateMcpConnection(manifest, contribution)

    if (contribution.deployment.type === "configured") {
      throw new Error(`Configured MCP deployments are runtime-only in ${manifest.id}`)
    }
    if (
      contribution.deployment.type === "local" &&
      (!contribution.deployment.command ||
        contribution.deployment.command.trim() !== contribution.deployment.command ||
        contribution.deployment.command.includes("\0"))
    ) {
      throw new Error(`Invalid local MCP executable declaration in ${manifest.id}`)
    }
    if (contribution.deployment.type === "hosted") {
      validateHostedUrl(manifest.id, contribution.deployment.url)
      for (const [name, value] of Object.entries(contribution.deployment.headers ?? {})) {
        if (!headerNamePattern.test(name) || /authorization|cookie|token|secret/i.test(name)) {
          throw new Error(`Hosted MCP header is not an audited static selector in ${manifest.id}: ${name}`)
        }
        if (!value || value.trim() !== value || /[\r\n]/.test(value)) {
          throw new Error(`Invalid hosted MCP header value in ${manifest.id}: ${name}`)
        }
      }
    }
    if (
      contribution.deployment.type === "customer-url" &&
      (!contribution.deployment.path.startsWith("/") ||
        contribution.deployment.path.startsWith("//") ||
        contribution.deployment.path.includes("\\"))
    ) {
      throw new Error(`Customer MCP path must be an absolute URL path in ${manifest.id}`)
    }

    if (manifest.trust === "official") continue
    if (contribution.deployment.type === "local") {
      throw new Error(`${manifest.trust} extension ${manifest.id} cannot execute a local MCP command`)
    }
    if (contribution.adapter !== `mcp:${contribution.id}`) {
      throw new Error(`${manifest.trust} extension ${manifest.id} must use its generic MCP adapter`)
    }
    if (contribution.authentication !== "none" && contribution.authentication !== "oauth") {
      throw new Error(`${manifest.trust} extension ${manifest.id} cannot inject MCP credentials`)
    }
    if (contribution.secrets.length) {
      throw new Error(`${manifest.trust} extension ${manifest.id} cannot declare adapter-managed secrets`)
    }
  }
}

const reservedAgentIDs = new Set([
  "build",
  "plan",
  "general",
  "explore",
  "worker",
  "adversarial-review",
  "harness-reviewer",
  "qualification",
  "research",
  "lobby",
  "compaction",
  "title",
  "summary",
])

function validateSkillPolicy(manifest: Extension.Manifest, contribution: Extension.Skill) {
  if (contribution.source.type === "discovered") {
    throw new Error(`Discovered skill sources are runtime-only in ${manifest.id}`)
  }
  if (contribution.adapter !== `skill:${contribution.id}`) {
    throw new Error(`Skill adapter must match its contribution id in ${manifest.id}`)
  }
  if (contribution.secrets.length > 0) throw new Error(`Skill contributions cannot declare secrets in ${manifest.id}`)
  if (contribution.source.type === "catalog" && contribution.source.content.trim() !== contribution.source.content) {
    throw new Error(`Catalog skill content must be trimmed in ${manifest.id}`)
  }
  if (new Set(contribution.requires).size !== contribution.requires.length) {
    throw new Error(`Catalog skill requirements must be unique in ${manifest.id}`)
  }
  if (contribution.agent && reservedAgentIDs.has(contribution.id)) {
    throw new Error(`Catalog subagent uses a reserved id in ${manifest.id}: ${contribution.id}`)
  }
}

const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const protectedHeaderNames = new Set(["cookie", "set-cookie", "proxy-authorization"])

function validateMcpConnection(manifest: Extension.Manifest, contribution: Extension.Mcp) {
  const connection = contribution.connection
  if (!connection) return
  if (manifest.trust !== "official") {
    throw new Error(`${manifest.trust} extension ${manifest.id} cannot inject MCP connection credentials`)
  }

  const configuration = new Map((contribution.configuration ?? []).map((field) => [String(field.id), field]))
  const secrets = new Map(contribution.secrets.map((secret) => [String(secret.id), secret]))
  const staticHeaders = new Set(
    contribution.deployment.type === "hosted"
      ? Object.keys(contribution.deployment.headers ?? {}).map((name) => name.toLowerCase())
      : [],
  )

  if (connection.oauth) {
    if (contribution.authentication !== "oauth") {
      throw new Error(`MCP OAuth connection binding requires OAuth authentication in ${manifest.id}`)
    }
    const client = configuration.get(String(connection.oauth.clientId))
    if (!client || !client.required) {
      throw new Error(`MCP OAuth client ID must reference required configuration in ${manifest.id}`)
    }
    if (connection.oauth.clientSecret && !secrets.has(String(connection.oauth.clientSecret))) {
      throw new Error(`MCP OAuth client secret is not declared in ${manifest.id}`)
    }
    const scope = connection.oauth.scope
    if (scope && (!scope.trim() || scope.trim() !== scope || /[\r\n]/.test(scope))) {
      throw new Error(`Invalid MCP OAuth scope in ${manifest.id}`)
    }
  }

  const headerNames = new Set<string>()
  for (const binding of connection.headers ?? []) {
    const name = binding.name.toLowerCase()
    if (!headerNamePattern.test(binding.name) || protectedHeaderNames.has(name)) {
      throw new Error(`Invalid MCP connection header in ${manifest.id}: ${binding.name}`)
    }
    if (headerNames.has(name) || staticHeaders.has(name)) {
      throw new Error(`Duplicate MCP connection header in ${manifest.id}: ${binding.name}`)
    }
    headerNames.add(name)
    if (Boolean(binding.secret) === Boolean(binding.configuration)) {
      throw new Error(`MCP connection header must reference exactly one source in ${manifest.id}: ${binding.name}`)
    }
    if (binding.secret && !secrets.get(String(binding.secret))?.required) {
      throw new Error(`MCP connection header secret must be required in ${manifest.id}: ${binding.name}`)
    }
    if (binding.configuration && !configuration.get(String(binding.configuration))?.required) {
      throw new Error(`MCP connection header configuration must be required in ${manifest.id}: ${binding.name}`)
    }
    if (binding.prefix && /[\r\n]/.test(binding.prefix)) {
      throw new Error(`Invalid MCP connection header prefix in ${manifest.id}: ${binding.name}`)
    }
    if (name === "authorization" && (binding.secret === undefined || binding.prefix !== "Bearer ")) {
      throw new Error(`Authorization MCP connection headers require a Bearer secret in ${manifest.id}`)
    }
  }
}

function validateToolPolicy(
  manifest: Extension.Manifest,
  contribution: Extension.Tool | Extension.Data | Extension.Mcp,
) {
  const allowed = new Set<string>()
  for (const tool of contribution.tools.allow) {
    if (!tool || tool.trim() !== tool || tool.includes("\0")) {
      throw new Error(`Invalid tool allow entry in ${manifest.id}`)
    }
    if (allowed.has(tool)) throw new Error(`Duplicate tool allow entry in ${manifest.id}: ${tool}`)
    allowed.add(tool)
  }

  const writes = new Set<string>()
  for (const tool of contribution.tools.write) {
    if (writes.has(tool)) throw new Error(`Duplicate write-tool entry in ${manifest.id}: ${tool}`)
    if (!allowed.has(tool)) throw new Error(`write tool is not allowed in ${manifest.id}: ${tool}`)
    writes.add(tool)
  }

  const implicitWrite = contribution.tools.allow.find(
    (tool) =>
      !tool.startsWith("get_action_set_") &&
      /(?:^|[-_])(?:append|create|delete|duplicate|move|remove|rename|set|update|write)(?:$|[-_])/.test(tool) &&
      !writes.has(tool),
  )
  if (implicitWrite) throw new Error(`mutating tool must be declared writable in ${manifest.id}: ${implicitWrite}`)
}

function validateLinearDynamicPolicy(manifest: Extension.Manifest, contribution: Extension.Mcp) {
  const actual = {
    manifest: String(manifest.id),
    contribution: String(contribution.id),
    adapter: contribution.adapter,
    deployment:
      contribution.deployment.type === "hosted"
        ? `${contribution.deployment.type}:${contribution.deployment.url}`
        : contribution.deployment.type,
    authentication: contribution.authentication,
    localOnly: contribution.localOnly,
    secrets: contribution.secrets.map((secret) => `${secret.id}:${secret.required}`).join(","),
    allow: contribution.tools.allow.join(","),
    write: contribution.tools.write.join(","),
  }
  const expected = {
    manifest: "turenlabs/linear",
    contribution: "linear",
    adapter: "security:linear",
    deployment: "hosted:https://mcp.linear.app/mcp",
    authentication: "key",
    localOnly: true,
    secrets: "LINEAR_API_KEY:true",
    allow: "linear_tools,linear_call",
    write: "linear_call",
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Invalid audited Linear dynamic upstream policy in ${manifest.id}`)
  }
}

export function validateCatalogPolicy(manifests: ReadonlyArray<Extension.Manifest>) {
  const secrets = new Map<string, Extension.ID>()
  for (const manifest of manifests) {
    for (const secret of manifest.contributions.flatMap((contribution) => contribution.secrets)) {
      const owner = secrets.get(secret.id)
      if (owner) throw new Error(`Extension secret ${secret.id} is declared by both ${owner} and ${manifest.id}`)
      secrets.set(secret.id, manifest.id)
    }
  }
}

function validateHostedUrl(id: Extension.ID, value: string) {
  const url = new URL(value)
  const hostname = url.hostname.toLowerCase()
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`Hosted MCP URL must use credential-free HTTPS in ${id}`)
  }
  if (
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname === "::" ||
    hostname === "::1" ||
    hostname === "metadata.google.internal" ||
    hostname === "169.254.169.254" ||
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname) ||
    hostname.startsWith("169.254.")
  ) {
    throw new Error(`Hosted MCP URL must use a public host in ${id}`)
  }
}
