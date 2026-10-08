# http-cache-semantics (vendored)

Upstream `http-cache-semantics@4.2.0` verbatim, plus a fix for CVE-2026-93748
(request `max-stale` could force reuse of security-restricted responses in
shared caches). No patched upstream release exists; the fix follows the
semantics of unmerged upstream PR https://github.com/kornelski/http-cache-semantics/pull/58.

The version is bumped to 4.2.1 so the workspace `overrides` entry resolves it
outside the vulnerable `<=4.2.0` range. Drop this directory and the override
once an upstream release ships the fix.
