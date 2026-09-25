# Intel feeds

Every TurenOS server polls public vulnerability and security-news feeds and shows the results on the Home page's
**Intel** tab. The scheduler starts with the server process, so it also runs on headless, SSH remote, and WSL backends:
each of those hosts makes outbound requests to the feeds below unless the feeds are disabled.

## What is polled

The defaults are in `DEFAULT_FEEDS` (`packages/server/src/intel/sources.ts`). All are enabled until you turn them off.

| Feed              | Kind     | Source                                                                                     |
| ----------------- | -------- | ------------------------------------------------------------------------------------------ |
| CISA KEV          | `kev`    | `https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json`      |
| NVD (last 7d)     | `nvd`    | `https://services.nvd.nist.gov/rest/json/cves/2.0/`, CVEs published in the last seven days |
| EPSS              | `epss`   | `https://api.first.org/data/v1/epss`                                                       |
| GitHub Advisories | `github` | `https://api.github.com/advisories`, unauthenticated                                       |
| CISA News         | `rss`    | `https://www.cisa.gov/news.xml`                                                            |
| BleepingComputer  | `rss`    | `https://www.bleepingcomputer.com/feed/`                                                   |
| The Hacker News   | `rss`    | `https://feeds.feedburner.com/TheHackersNews`                                              |
| SANS ISC          | `rss`    | `https://isc.sans.edu/rssfeed_full.xml`                                                    |
| Dark Reading      | `rss`    | `https://www.darkreading.com/rss.xml`                                                      |
| GreyNoise         | `rss`    | `https://www.greynoise.io/blog/rss.xml` (the blog, not GreyNoise threat data)              |
| StepSecurity      | `rss`    | `https://www.stepsecurity.io/blog/rss.xml`                                                 |

The Intel tab's settings can disable any feed, add an HTTP(S) feed of one of the five kinds, or reset the list to the
defaults. These are display feeds for the Intel tab. They are separate from the data sources in the extension catalog,
whose admission rules are in [threat intelligence feed rights](./developer-catalog-runtime/feed-licenses.md).

## Schedule

`startScheduler()` runs once when the product server starts (`packages/forge/src/server/server.ts`) and then wakes every
six hours. A wake polls only when the stored snapshot is older than six hours, so restarting the server does not poll
twice. Two actions poll immediately regardless of age: opening the Intel tab for the first time for each server in the
current app session, and **Refresh** on the tab. Both call `POST /api/intel/poll`. One poll runs at a time per process; an
overlapping tick or request is skipped.

Each feed request has a 15-second deadline that also covers reading the body. A failed request keeps that category's
previous advisories, KEV entries, or news instead of emptying them, and records the failure in the feed's status. The
snapshot's poll time advances only when at least one feed succeeds, so a total outage is retried on the next wake.

## Storage and API

The snapshot is `intel-cache.json` and the feed list is `intel-feeds.json`, both in the server's state directory
(`Global.Path.state`, `~/.local/state/forge` by default). The cache file is replaced atomically.

The Protocol `intel` group serves `/api/intel/advisories`, `kev`, `news`, `trends`, `status`, `feeds` (list, add,
update, reset), and `poll`.

## Limits

- There is no global off switch. To stop outbound polling, disable every feed in the Intel settings.
- NVD and GitHub requests are unauthenticated, so they are subject to those services' anonymous rate limits.
- The feeds are for people to read. No agent tool reads the Intel snapshot.

## Source

- [`packages/server/src/intel/scheduler.ts`](../../packages/server/src/intel/scheduler.ts)
- [`packages/server/src/intel/ingest.ts`](../../packages/server/src/intel/ingest.ts)
- [`packages/server/src/intel/sources.ts`](../../packages/server/src/intel/sources.ts)
- [`packages/server/src/intel/feeds.ts`](../../packages/server/src/intel/feeds.ts)
- [`packages/server/src/handlers/intel.ts`](../../packages/server/src/handlers/intel.ts)
- [`packages/protocol/src/groups/intel.ts`](../../packages/protocol/src/groups/intel.ts)
- [`packages/app/src/pages/home/intel-tab.tsx`](../../packages/app/src/pages/home/intel-tab.tsx)
