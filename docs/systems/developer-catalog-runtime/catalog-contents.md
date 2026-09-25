# Catalog contents

What the built-in catalog ships, as of 2026-09-25. The manifests in `services/catalog/manifests/` are the source of truth;
update this page in the same change as any manifest you add or remove.

## Data sources

The catalog contains 23 cybersecurity data sources:

- CISA Known Exploited Vulnerabilities
- CIRCL Hashlookup
- deps.dev
- ENISA EUVD
- EPSS by FIRST.org
- Exploit-DB
- CERT-FR MISP
- Datadog Malicious Artifacts
- GitHub Security Advisories
- GTFOBins
- Have I Been Pwned
- LOLBAS
- MITRE ATT&CK
- MITRE CWE
- MITRE D3FEND
- NIST NVD
- OpenSSF Scorecard
- OSV
- Phishing.Database
- Tor Exit Nodes
- TweetFeed
- Exa Web Search
- Parallel Web Search

Every entry declares its exact agent-facing tool allowlist. All `tools.write` lists are empty.
Threat-feed rights and exclusions are recorded in [threat intelligence feed rights](./feed-licenses.md).

## Skills and subagents

The catalog contains eleven downloadable skills:

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
- Customize Forge

It also contains four downloadable subagents:

- Software Architecture Reviewer
- Vulnerability Analyst
- Incident Responder
- Threat Hunter

Catalog prompts are original Turen content. They do not grant permissions. Subagents select only one host-defined profile (`read`, `data`, or `binary`), and Turen constructs the fixed read-only permission set.
