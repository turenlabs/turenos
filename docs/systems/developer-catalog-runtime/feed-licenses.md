# Threat intelligence feed rights

The catalog admits threat feeds only when the data, not merely client code, has clear product-compatible rights. TurenOS performs bounded point lookup or event retrieval and preserves source provenance. This page covers threat feeds only; it does not record data rights for the catalog's other data sources.

| Source                                                     | Data rights                        | Product handling                                                                    |
| ---------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------- |
| TweetFeed                                                  | CC0-1.0                            | Preserve reporter/tweet provenance; omit separately licensed enrichment objects.    |
| Tor exit list (`check.torproject.org`)                     | CC0-1.0                            | Classify anonymity only; never describe Tor use as malicious by itself.             |
| Phishing.Database                                          | MIT                                | Preserve copyright and MIT notice in product legal material; no bulk export.        |
| CERT-FR MISP                                               | Etalab Open Licence 2.0, TLP:CLEAR | Attribute CERT-FR/ANSSI, preserve TLP/PAP and update timestamps.                    |
| Datadog Malicious Artifacts (AI skills and IDE extensions) | Apache-2.0                         | Attribute Datadog; query manifests only and never retrieve samples.                 |
| OpenSSF malicious packages through OSV                     | Apache-2.0 records in OSV          | Preserve MAL/source IDs, origins, evidence hashes, aliases, and withdrawal history. |

Public access is not a licence. IPsum, Block List Project, HaGeZi, DShield, GreenSnow, Binary Defense, blocklist.de, CINSscore, URLhaus, ThreatFox, MalwareBazaar, OpenPhish, GreyNoise, OTX, Shodan InternetDB, and VirusTotal free tiers are excluded because upstream rights are mixed, commercial/product use is restricted, or redistribution terms are unclear. Feodo Tracker, SSLBL, and Spamhaus DROP are excluded because their overarching formal terms conflict with the permissions on their feed pages.
