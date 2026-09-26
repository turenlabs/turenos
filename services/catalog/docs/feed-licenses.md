# Threat Intelligence Feed Rights

The catalog admits feeds only when the data, not merely client code, has clear product-compatible rights. Turen performs bounded point lookup or event retrieval and preserves source provenance.

| Source | Data rights | Product handling |
|---|---|---|
| TweetFeed | CC0-1.0 | Preserve reporter/tweet provenance; omit separately licensed enrichment objects. |
| Tor Metrics exit data | CC0-1.0 | Classify anonymity only; never describe Tor use as malicious by itself. |
| Phishing.Database | MIT | Preserve copyright and MIT notice in product legal material; no bulk export. |
| CERT-FR MISP | Etalab Open Licence 2.0, TLP:CLEAR | Attribute CERT-FR/ANSSI, preserve TLP/PAP and update timestamps. |
| Datadog malicious packages | Apache-2.0 | Attribute Datadog; query manifests only and never retrieve samples. |
| MITRE CAPEC | Royalty-free for research, development, and commercial purposes; MITRE requires its copyright designation and license to accompany copies. | Return MITRE attribution with results and reproduce the required copyright, license, and disclaimer notices below. |
| OpenSSF malicious packages through OSV | Apache-2.0 records in OSV | Preserve MAL/source IDs, origins, evidence hashes, aliases, and withdrawal history. |

Public access is not a licence. IPsum, Block List Project, HaGeZi, DShield, GreenSnow, Binary Defense, blocklist.de, CINSscore, URLhaus, ThreatFox, MalwareBazaar, OpenPhish, GreyNoise, OTX, Shodan InternetDB, and VirusTotal free tiers are excluded because upstream rights are mixed, commercial/product use is restricted, or redistribution terms are unclear. Feodo Tracker, SSLBL, and Spamhaus DROP were removed after newer overarching/formal terms conflicted with older feed-page permissions.

## MITRE CAPEC

The official latest XML download is public and requires no account or API key. MITRE's downloads page lists CAPEC 3.9, dated 2023-01-24; this is a maintained-as-published attack-pattern taxonomy, not a current vulnerability or threat feed. Turen fetches the fixed official download at most once per day per cache and returns bounded lookup/search results.

MITRE's [CAPEC Terms of Use](https://capec.mitre.org/about/termsofuse.html) grant a non-exclusive, royalty-free license for research, development, and commercial purposes and require reproducing the copyright designation and license with copies. Preserve this notice when reproducing CAPEC content:

> Copyright © 2007–2026, The MITRE Corporation. CAPEC and the CAPEC logo are trademarks of The MITRE Corporation.
>
> The MITRE Corporation (MITRE) hereby grants you a non-exclusive, royalty-free license to use Common Attack Pattern Enumeration and Classification (CAPEC™) for research, development, and commercial purposes. Any copy you make for such purposes is authorized provided that you reproduce MITRE's copyright designation and this license in any such copy.

MITRE's terms also publish this disclaimer; CAPEC lookup and search results include it with the required notices:

> ALL DOCUMENTS AND THE INFORMATION CONTAINED THEREIN ARE PROVIDED ON AN "AS IS" BASIS AND THE CONTRIBUTOR, THE ORGANIZATION HE/SHE REPRESENTS OR IS SPONSORED BY (IF ANY), THE MITRE CORPORATION, ITS BOARD OF TRUSTEES, OFFICERS, AGENTS, AND EMPLOYEES, DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTY THAT THE USE OF THE INFORMATION THEREIN WILL NOT INFRINGE ANY RIGHTS OR ANY IMPLIED WARRANTIES OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
