# Catalog contents

The built-in catalog inventory as of 2026-09-25 is defined by the manifests in `services/catalog/manifests/`.

## Data sources

The catalog contains 23 data sources: 21 cybersecurity sources served by `security:` adapters and two web-search
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

The catalog contains ten downloadable skills plus the built-in Customize TurenOS skill, whose `embedded` source ships
with TurenOS and is not downloaded or scanned by Vigil:

- Secure Code Review
- Bug Root Cause
- Test Strategy
- Dependency Risk Review
- Threat Intelligence Brief
- Detection Engineering Review
- Incident Evidence Triage
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

The catalog contains 25 MCP integrations, all official and all disabled until enabled. `Deployment` is the manifest's
`deployment.type`: `hosted` is the vendor's endpoint, `customer-url` is an endpoint URL the user supplies, `managed` is a
package TurenOS runs through its managed MCP runtime, and `local` is a program already installed on the host. `Write
tools` counts the manifest's `tools.write` allowlist; the rest are read-only.

| Integration                                 | ID                                     | Deployment     | Write tools |
| ------------------------------------------- | -------------------------------------- | -------------- | ----------- |
| 1Password Developer Environments            | `turenlabs/onepassword`                | `local`        | 0           |
| Atlassian Security Context                  | `turenlabs/atlassian-security-context` | `hosted`       | 0           |
| Automox                                     | `turenlabs/automox-local`              | `managed`      | 0           |
| Automox Hosted                              | `turenlabs/automox`                    | `hosted`       | 0           |
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

The catalog contains 10 official tool extensions, all disabled until enabled and none with write tools: Bandit, Batou,
Checkov, Gitleaks, Grype, Native Audits, Opengrep, OSV-Scanner, Trivy, and Yolk Change Intelligence
(`turenlabs/<name>` IDs; Native Audits is `turenlabs/native-audit`). Yolk uses the built-in `builtin:yolk` adapter; the
others use `security:` adapters.
