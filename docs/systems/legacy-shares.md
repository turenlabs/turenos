# Legacy session shares

TurenOS no longer creates public share links for sessions. It keeps only the ability to revoke a share that an older
build created, and it makes that network call only when `FORGE_LEGACY_SHARE_ENDPOINT` names an audited endpoint.
Until a revocation is positively acknowledged, the local share record and its secret are kept.

## How it works

1. Each legacy share is a `session_share` row: the session ID, the remote share ID, its URL, and the share secret. On
   startup `ShareNext` seals any plaintext secret with `SecretVault` under the `session-share` scope.
2. Unsharing a session (the **Unshare session** command, or `DELETE /session/:sessionID/share`) calls
   `SessionShare.unshare`. It first checks that the caller may mutate the session's task.
3. `ShareNext.remove` opens the secret and sends `DELETE <endpoint>/api/share/<shareID>` with the secret in the body.
   When a signed-in account with an active organization matches the endpoint's origin, it instead uses
   `/api/shares/<shareID>` with that account's bearer token and `x-org-id`.
4. Only a success response deletes the local row and clears the session's share URL. Any other status, including
   `404`, fails the request and keeps the credentials, because the configured endpoint may not be the backend that
   created the share.

## Configuration

`FORGE_LEGACY_SHARE_ENDPOINT` must be an HTTPS URL, or plain HTTP on `localhost`, `127.0.0.1`, or `::1`. It may not
contain credentials, a query, or a fragment. Without it every revocation fails with "Legacy share network access is
disabled". Account credentials are attached only when the endpoint's origin matches the active account's origin.

## Verification

```sh
bun test --cwd packages/forge test/share/share-next.test.ts
```

## Limits

- There is no way to create a new share.
- A session marked shared with no local share record cannot be revoked from TurenOS.
- The record does not say which backend created a share, so revocation depends on the operator pointing the endpoint
  at the right one.

## Source

- [`packages/forge/src/share/share-next.ts`](../../packages/forge/src/share/share-next.ts)
- [`packages/forge/src/share/session.ts`](../../packages/forge/src/share/session.ts)
- [`packages/core/src/share/sql.ts`](../../packages/core/src/share/sql.ts)
- Tests: [`packages/forge/test/share/share-next.test.ts`](../../packages/forge/test/share/share-next.test.ts)
