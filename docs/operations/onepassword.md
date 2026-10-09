# 1Password For Agents And Factories

The 1Password Environments MCP server manages Environment metadata and local mounts.
It never returns secret values to the agent.
Authorized processes can use secrets through a local environment mount.
This integration does not inject secrets into every agent, shell, or factory automatically.

## Setup

1. Install the 1Password desktop app on the machine running the TurenOS backend.
2. In 1Password Settings, open Labs and enable the local MCP server.
3. In Developer settings, enable Integrate with MCP clients.
4. Create a dedicated Environment with only the credentials needed for the task.
5. Enter secret values in 1Password, not in chat or tool arguments.
6. In TurenOS Extensions, enable 1Password Developer Environments.
7. If mount creation or Environment changes are needed, turn on Allow write tools and save.
8. Ask the agent to authenticate, list Environment names, and select the intended Environment.
9. Approve the requested access in the 1Password desktop app.
10. Ask the agent to reuse or create a local environment mount for the intended project.

Write tools remain subject to agent permissions and ask for approval by default.
Do not grant broad permission changes to remove these checks.
Use tool search to discover 1Password tools in agent sessions.
Read-only agents and scoped workers may lack permission to create mounts or start processes.

## Use Secrets

Configure the intended application to load the approved mount as its environment file.
Do not read the mount with file tools or print its contents in shell output.
Do not copy its values into configuration, logs, prompts, or source files.
Keep mount paths out of source control and exclude them from agent file reads.
Check variable names with `list_variables`, not secret values.

Each worktree needs an approved mount path or process configuration for its task.
Do not reuse credentials from an unrelated project or Environment.
The MCP server cannot retrieve arbitrary vault passwords or provide secrets directly to model context.

## Factories

Interactive factory sessions can use the same integration on the backend machine.
Access still depends on agent permissions and 1Password desktop authorization.
Authorization expires when 1Password locks.
Remote backends need their own supported 1Password installation; the desktop client's installation is not forwarded.

For unattended work, provision a separate least-privilege machine credential path.
For example, use a restricted 1Password service account with the CLI outside the model's tool arguments.
The desktop MCP server is not an unattended credential broker.
Do not put a service-account token in chat, committed files, or factory prompts.

## Installation Checks

TurenOS rejects group-writable and world-writable vendor executables.
On macOS, the resolved path must be `/Applications/1Password.app/Contents/MacOS/1password-mcp`.
TurenOS verifies its code signature against 1Password's Developer ID and executable identity.
User-owned macOS installations are supported when this signature check succeeds.
Linux installations must be root-owned and resolve under the audited system or vendor installation roots.
Windows is not supported by this catalog integration.

## References

- [1Password Environments MCP server](https://www.1password.dev/environments/mcp-server)
- [Secure AI access](https://www.1password.dev/get-started/secure-ai-access)
