# Devin CLI integration research

Status: adopted, as of 2026-10-28.

The [Devin CLI provider](../../providers/devin-cli.md) adopts the managed ACP route with private TurenOS MCP tools. Use that page for current setup, controls, and limits.

The sections below record the initial research from 2026-10-27. Its initialize-only probe preceded the runtime implementation and authenticated qualification on 2026-10-28.

## Initial recommendation

1. Use the existing terminal for immediate access.
2. Build a bounded ACP compatibility spike, including native-tool exclusion tests.
3. If enforcement passes, reuse the managed-provider route with private TurenOS MCP tools.
4. Otherwise, offer only an opt-in external-agent session with its authority disclosed.

Do not copy the Claude Code wire protocol. Do not treat Devin as an OpenAI-compatible HTTP model provider.

Start with local Devin. Keep cloud execution and `/handoff` outside the first integration.

## Research scope

| Item                 | Observed value                                                                      |
| -------------------- | ----------------------------------------------------------------------------------- |
| Date                 | 2026-10-27                                                                          |
| Research branch      | `devin-cli-research`                                                                |
| Worktree             | `.worktrees/devin-cli-research`                                                     |
| TurenOS baseline     | `origin/main`, commit `b1502839`, version `1.0.48`                                  |
| Installed executable | `/Users/tom/.local/bin/devin`                                                       |
| Executable version   | `devin 3000.11.228 (053434014dbd)`                                                  |
| Official npm package | `devin@3000.11.228`                                                                 |
| Stable release date  | 2026-10-26, from the [stable changelog](https://docs.devin.ai/cli/changelog/stable) |
| Live test            | ACP `initialize` only, with no authentication request or model prompt               |

The original checkout has unrelated changes. Research files stay in the new worktree and do not include those changes.

### Evidence levels

**Observed** means a local command or repository inspection confirmed the statement. **Documented** means an official source describes it. **Proposed** means it is integration design, not existing behavior.

The handshake confirms advertised capabilities. It does not confirm account access, tool execution, session recovery, or permission enforcement.

## Use it today

1. Open the project in TurenOS.
2. Open its terminal.
3. Run `pwd` to check the working directory.
4. Run `devin --version` to check installation on that backend.
5. If login is needed, run `devin auth login`.
6. Run `devin auth status` to check login locally.
7. Run `devin` to start the interactive agent.

Devin is already installed on the researched Mac. No installation or login was performed for this research.

If another backend lacks Devin, its official npm installation is:

```sh
npm install -g devin@3000.11.228
```

The version above is the researched build, not a permanent latest-version claim. Official installation also supports native installers and Homebrew. See the [installation guide](https://docs.devin.ai/cli).

Useful commands inside the project terminal:

```sh
devin
devin --model opus
devin -c
devin -r SESSION_ID
```

`-c` resumes the latest Devin session in the current directory. `-r` selects a Devin session, not a TurenOS session.

This route gives the standalone Devin terminal UI. It does not add Devin to the TurenOS model picker or session transcript. TurenOS agent permission rules do not mediate commands that the user runs in a shell.

For SSH or WSL backends, install and authenticate Devin on that backend. A Desktop-side installation does not install it remotely. Terminal support exists in [Core PTY](../../../packages/core/src/pty.ts#L174) and the [app terminal](../../../packages/app/src/components/terminal.tsx).

## Compare the routes

| Route                                         | Value                                                            | Main limit                                                        | Decision                                 |
| --------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------- |
| Existing terminal                             | Full standalone CLI with no runtime change                       | Separate UI and history; direct shell authority                   | Use now                                  |
| ACP client                                    | Streaming chat, tool cards, permissions, models, session loading | Requires a client transport and an explicit authority model       | Recommended native route                 |
| `devin -p` with ATIF export                   | Batch scripts and completed transcript capture                   | Not a documented live event or bidirectional control API          | Optional batch tool, not chat foundation |
| Claude Code adapter with a changed executable | Little apparent setup                                            | Wrong protocol, flags, tool controls, and persistence assumptions | Reject                                   |
| Devin Cloud API or MCP                        | Delegate work to remote Devin sessions                           | Different workspace, credentials, lifetime, and billing           | Separate future feature                  |

The official CLI is an MCP **client**. `devin mcp` manages its server connections. `devin acp` is an ACP **agent/server**, not an MCP server. The [Devin MCP service](https://docs.devin.ai/work-with-devin/devin-mcp) controls cloud services; it is not local CLI transport.

## Account, cost, and terms

Use the user's own Devin installation and login. The command reference gives `WINDSURF_API_KEY` precedence over stored `devin auth login` credentials. ACP `authenticate` can supply runtime credentials. Check inherited variables before relying on the stored account. Do not copy a token into TurenOS chat, configuration, or logs.

The [enterprise auth guide](https://docs.devin.ai/cli/enterprise/devin-auth) documents persistent `credentials.toml` tokens. That page describes Enterprise RBAC and ACU billing, not a universal Enterprise-only CLI requirement. The [Zed guide](https://docs.devin.ai/cli/acp/zed) also documents free account signup.

Published plan prices, observed 2026-10-27:

| Plan       | Published price                                    | Relevant condition                                  |
| ---------- | -------------------------------------------------- | --------------------------------------------------- |
| Free       | $0                                                 | Light quota and limited models                      |
| Pro        | $20/month                                          | Larger quota and frontier models                    |
| Max        | $200/month                                         | Weekly quota; no daily cap in detailed billing docs |
| Teams      | Billing docs: $80/month minimum; $40 per full seat | Conflicting marketing wording; see below            |
| Enterprise | Custom                                             | Agreement and access policy control                 |

The [pricing page](https://devin.ai/pricing) says "$80/month for team plan + $40/mo per full dev seat". The [detailed billing guide](https://docs.devin.ai/admin/billing/self-serve) instead describes an $80 total minimum, satisfied by seats and prepaid credits. Its examples total $80 for two full seats and $120 for three. Confirm the invoice formula before presenting a Teams cost estimate.

The detailed guide gives Pro and Teams full seats daily and weekly allowances. Max has only a weekly allowance. It does not publish fixed quota sizes. Enterprise CLI usage counts toward its ACU allocation.

Eligible Pro, Max, and Teams users can link a ChatGPT plan for covered GPT requests. The [billing guide](https://docs.devin.ai/admin/billing/chatgpt) says local CLI requests can fall back to Devin quota, then paid credits, when ChatGPT is unavailable. This is not free or isolated billing. Do not price every Devin model with upstream API rates or label unknown charges as free.

The npm license field points to [Cognition's platform terms](https://cognition.ai/terms-of-service). The public [repository](https://github.com/CognitionAI/devin-cli) contains distribution tooling, not the Rust agent implementation.

The terms restrict copying, redistribution, reverse engineering, competing-product use, and access outside authorized users. ACP interoperability is documented, but it is not a redistribution grant. Obtain legal or vendor approval before bundling, reselling, sharing credentials, or releasing an integration with uncertain terms. This is an engineering constraint, not a legal conclusion.

Local execution does not mean offline model processing. Review the account's data controls before sending project content. General paid users can opt out of training use; Teams requires an administrator. [Enterprise security terms](https://docs.devin.ai/admin/security#privacy--intellectual-property) state a separate consent rule for Enterprise data.

## Detailed findings

- [Protocol and measured behavior](./protocol.md): the live handshake, ACP lifecycle, event mapping, and version drift.
- [Implementation and safety](./implementation.md): source map, proposed changes, authority boundaries, delivery stages, and acceptance tests.

## Verification

Run from the research worktree:

```sh
bun mockups/devin-cli/probe.ts
bun .agents/skills/turen-documentation/scripts/check.ts docs
git diff --check
```

The [probe](../../../mockups/devin-cli/probe.ts) sends only `initialize`. No model request, login, cloud session, dependency installation, or runtime integration was needed.

Independent verification on 2026-10-27 returned:

| Check                 | Result                                                      |
| --------------------- | ----------------------------------------------------------- |
| Initialize-only probe | Exit 0; advertised capabilities match the protocol findings |
| Documentation checker | 97 pages checked; 0 errors, 0 warnings                      |
| `git diff --check`    | Exit 0 for tracked changes                                  |
| Worktree scope        | Only documentation and the diagnostic prototype changed     |

The whitespace command does not inspect untracked files. Source review covered the new report pages and probe.

## Limits

- No authenticated `session/new`, prompt, write, shell command, MCP call, or session load was tested.
- The research did not benchmark speed, cost, cancellation, or account quotas.
- Linux, Windows, WSL, SSH, and packaged Desktop behavior need qualification.
- Advertised private extensions do not establish a stable public contract.
- Official documentation is not fully synchronized with the current binary and changelog.

## Source

- [Devin commands](https://docs.devin.ai/cli/reference/commands), [ACP in Zed](https://docs.devin.ai/cli/acp/zed), and [stable changelog](https://docs.devin.ai/cli/changelog/stable).
- [Official npm metadata](https://registry.npmjs.org/devin/3000.11.228) and [pinned distribution publisher](https://github.com/CognitionAI/devin-cli/blob/37d6de3de0a3c45f218f9cb982791e49f4c87607/scripts/publish_npm.py).
- [Self-serve billing](https://docs.devin.ai/admin/billing/self-serve) and [ChatGPT plan billing](https://docs.devin.ai/admin/billing/chatgpt).
- [ACP initialization](https://agentclientprotocol.com/protocol/initialization) and [TypeScript SDK](https://agentclientprotocol.com/libraries/typescript).
- [Existing TurenOS ACP server](../../../packages/forge/src/cli/cmd/acp.ts#L49), [model routes](../../../packages/core/src/session/runner/model.ts#L1060), and [Session runner](../../../packages/core/src/session/runner/llm.ts#L916).
- [Research probe](../../../mockups/devin-cli/probe.ts).
