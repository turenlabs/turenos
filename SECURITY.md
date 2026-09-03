# TurenOS security policy

TurenOS is a security engineering agent with access to powerful local capabilities. Its permission prompts help an operator understand and approve actions; they are not a security sandbox.

## Trust boundary

- Tools and generated commands run with the privileges of the TurenOS process.
- Repository instructions, tool output, model output, MCP servers, plugins, and downloaded content may be untrusted.
- Configured model providers receive the data sent to them according to their own policies.
- Server mode exposes agent capabilities to clients that can reach it. Set `FORGE_SERVER_PASSWORD`, bind to an appropriate interface, and place remote deployments behind transport security. The `FORGE_*` name is a retained runtime compatibility contract.
- Secrets should be supplied through scoped credentials and must not be copied into prompts, logs, or findings unless the workflow explicitly requires it.

Use a disposable VM or container for hostile repositories or samples. Future isolation features must be treated as defense in depth until their boundary has been independently verified.

## Reporting a vulnerability

Use the private [GitHub security advisory form](https://github.com/turenlabs/turenos/security/advisories/new). Include the affected revision, a minimal reproduction, impact, and any known mitigations. Do not open a public issue for an unpatched vulnerability.

Reports about an explicit, documented capability are not vulnerabilities by themselves. Boundary bypasses, credential exposure, cross-workspace or cross-tenant data access, unsafe update behavior, and actions occurring without the required authorization are in scope.
