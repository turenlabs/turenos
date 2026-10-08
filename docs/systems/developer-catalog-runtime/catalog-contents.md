# Catalog contents

The built-in catalog inventory as of 2026-10-04 is defined by the manifests in `services/catalog/manifests/`.

## Data sources

The catalog contains 24 data sources: 22 cybersecurity sources served by `security:` adapters and two web-search
sources served by `websearch:` adapters.

Cybersecurity sources:

- CISA KEV
- CIRCL Hashlookup
- deps.dev
- ENISA EUVD
- EPSS
- Exploit-DB
- CERT-FR MISP
- Datadog Malicious Artifacts
- GitHub Advisories
- GTFOBins
- Have I Been Pwned
- LOLBAS
- MITRE ATT&CK
- MITRE CAPEC
- MITRE CWE
- MITRE D3FEND
- NVD
- OpenSSF Scorecard
- OSV
- Phishing.Database
- Tor Exit Nodes
- TweetFeed

Web-search sources:

- Exa Web Search
- Parallel Web Search

Every data source declares its exact agent-facing tool allowlist, and every data source's `tools.write` list is empty.
Threat-feed rights and exclusions are recorded in [threat intelligence feed rights](./feed-licenses.md).
Listing a source is not a blanket licence to embed or redistribute its results. Other sources require their own
review before changing point lookups into bundled data or a cross-customer cache: [OpenSSF Scorecard](https://github.com/ossf/scorecard#scorecard-rest-api)
licenses REST API results under CDLA-Permissive-2.0; [deps.dev](https://docs.deps.dev/api/v3#data) licenses its
generated data under CC-BY-4.0 but says upstream aggregate inputs retain their own rights; and
[HIBP's current terms](https://haveibeenpwned.com/TermsOfUse) restrict third-party benefit and redistribution unless
the purchased service expressly allows it. Public access, an adapter's code licence, or a read-only tool declaration
does not settle data rights or service terms for the rest of this catalog. Keep each adapter's existing point-lookup
behavior and obtain a source-specific rights review before new storage or redistribution.

## Skills and subagents

The catalog contains seventeen downloadable skills plus the built-in Customize TurenOS skill, whose `embedded` source ships
with TurenOS and is not downloaded or scanned by Vigil:

- Secure Code Review
- Bug Root Cause
- Test Strategy
- Dependency Risk Review
- Dependency Upgrade Impact
- Threat Intelligence Brief
- Detection Engineering Review
- Incident Evidence Triage
- MCP Security Review
- Agentic Prompt-Injection Review
- OAuth/OIDC Security Review
- Tenant Isolation Review
- SLSA Build Provenance Review
- GitHub Actions Security Review
- Technical Security Blog
- Threat Model Review
- IaC Config Review

It also contains four downloadable subagents:

- Software Architecture Reviewer
- Vulnerability Analyst
- Incident Responder
- Threat Hunter

Catalog prompts are original Turen Labs content. They do not grant permissions. Subagents select only one host-defined profile (`read`, `data`, or `binary`), and TurenOS constructs the fixed read-only permission set.

## MCP integrations

The catalog contains 26 MCP integrations, all official and all disabled until enabled. `Deployment` is the manifest's
`deployment.type`: `hosted` is the vendor's endpoint, `customer-url` is an endpoint URL the user supplies, `managed` is a
package TurenOS runs through its managed MCP runtime, and `local` is a program already installed on the host. `Write
tools` counts the manifest's `tools.write` allowlist; the rest are read-only.

| Integration                                 | ID                                     | Deployment     | Write tools |
| ------------------------------------------- | -------------------------------------- | -------------- | ----------- |
| 1Password Developer Environments            | `turenlabs/onepassword`                | `local`        | 0           |
| Atlassian Security Context                  | `turenlabs/atlassian-security-context` | `hosted`       | 0           |
| Automox                                     | `turenlabs/automox-local`              | `managed`      | 0           |
| Automox Hosted                              | `turenlabs/automox`                    | `hosted`       | 0           |
| AWS Documentation                           | `turenlabs/aws-documentation`          | `managed`      | 0           |
| Chainguard Docs                             | `turenlabs/chainguard-docs`            | `hosted`       | 0           |
| Cloudflare Audit Logs                       | `turenlabs/cloudflare-audit-logs`      | `hosted`       | 0           |
| Cloudflare One CASB                         | `turenlabs/cloudflare-casb`            | `hosted`       | 0           |
| CrowdStrike Falcon                          | `turenlabs/crowdstrike-falcon`         | `managed`      | 0           |
| Datadog Security & Incident Response        | `turenlabs/datadog-security`           | `customer-url` | 7           |
| Elastic Security / Agent Builder            | `turenlabs/elastic-security`           | `customer-url` | 0           |
| GitHub Security                             | `turenlabs/github-security`            | `hosted`       | 0           |
| GitLab DevSecOps                            | `turenlabs/gitlab-devsecops`           | `hosted`       | 0           |
| Grafana Cloud Security Operations           | `turenlabs/grafana-cloud-security`     | `hosted`       | 0           |
| incident.io                                 | `turenlabs/incident-io`                | `hosted`       | 0           |
| JFrog Xray / Supply Chain Security          | `turenlabs/jfrog-xray`                 | `customer-url` | 0           |
| Linear                                      | `turenlabs/linear`                     | `hosted`       | 1           |
| Microsoft Graph Enterprise / Entra Identity | `turenlabs/microsoft-graph-enterprise` | `hosted`       | 0           |
| Microsoft Sentinel                          | `turenlabs/microsoft-sentinel`         | `hosted`       | 0           |
| Notion                                      | `turenlabs/notion`                     | `hosted`       | 9           |
| PagerDuty                                   | `turenlabs/pagerduty`                  | `hosted`       | 0           |
| Semgrep Hosted MCP                          | `turenlabs/semgrep-hosted`             | `hosted`       | 4           |
| Sentry                                      | `turenlabs/sentry`                     | `hosted`       | 0           |
| Socket                                      | `turenlabs/socket`                     | `hosted`       | 0           |
| SonarQube Cloud Security                    | `turenlabs/sonarqube-cloud-security`   | `hosted`       | 0           |
| Tenable                                     | `turenlabs/tenable`                    | `hosted`       | 4           |

## Tools

The catalog contains 11 official tool extensions, all disabled until enabled and none with write tools: Bandit, Batou,
Checkov, Gitleaks, Grype, Native Audits, Opengrep, OSV-Scanner, Trivy, zizmor, and Yolk Change Intelligence
(`turenlabs/<name>` IDs; Native Audits is `turenlabs/native-audit`). Yolk uses the built-in `builtin:yolk` adapter; the
others use `security:` adapters.

### GitHub Actions security review

Enable the **GitHub Actions Security Review** skill from Extend for a read-only review of an authorized workspace's
workflows and reachable local actions/scripts. It traces untrusted inputs and cross-workflow artifact/cache handoffs
to privileged execution, publishing, and deployment, distinguishing confirmed code-level paths from scanner candidates
and missing policy evidence. It proposes fixes and regression tests without applying or running them.

For scanner corroboration, separately install a trusted [zizmor](https://docs.zizmor.sh/installation/) executable
(1.25.0 or newer, for `--no-ignores`) on the runtime host's PATH and enable the **zizmor** tool extension. TurenOS does
not download or install this scanner. The
`zizmor_scan` tool defaults to `.github/workflows`; use a narrower workflow path or a local action's YAML when needed.
The skill discovers the tool through `tool_search` and, when needed, `tool_load`. If it is unavailable, the skill
continues manual inspection and reports the scanner coverage gap rather than substituting a shell command.

The adapter runs offline without repository configuration, suppression comments, or automatic fixes. Offline coverage
cannot establish remote action integrity, live repository settings, runner isolation, or cloud authorization. Source-derived
results still enter the agent conversation and may be sent to the configured model provider. The skill is a prompt-only
procedure, not a permission or sandbox boundary.

## Source

- [Catalog manifests](../../../services/catalog/manifests/)
- [GitHub Actions Security Review](../../../services/catalog/manifests/skills/github-actions-security-review.json)
- [zizmor tool manifest](../../../services/catalog/manifests/tools/zizmor.json)
- [zizmor adapter](../../../packages/forge/src/security/integrations/zizmor.ts)
