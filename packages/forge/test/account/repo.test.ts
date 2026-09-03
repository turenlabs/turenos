import { expect } from "bun:test"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Effect, Layer, Option } from "effect"
import { eq, sql } from "drizzle-orm"

import { AccountRepo } from "../../src/account/repo"
import { AccessToken, AccountID, OrgID, RefreshToken, RemoteAccountID } from "../../src/account/schema"
import { Database } from "@turenlabs/core/database/database"
import { AccountTable } from "@turenlabs/core/account/sql"
import { SecretVault } from "@turenlabs/core/secret-vault"
import { testEffect } from "../lib/effect"

const truncate = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(sql`DELETE FROM account_state`)
    yield* db.run(sql`DELETE FROM account`)
  }),
)
const truncateNode = LayerNode.make({ name: "truncate-account", layer: truncate, deps: [Database.node] })

const it = testEffect(
  LayerNode.compile(LayerNode.group([AccountRepo.node, truncateNode, Database.node, SecretVault.node])),
)

const activeID = () => AccountRepo.use.active().pipe(Effect.map((row) => Option.getOrThrow(row).id))

const storedRow = (id: AccountID) =>
  Database.Service.use((database) => database.db.select().from(AccountTable).where(eq(AccountTable.id, id)).get())

const scope = (id: AccountID) => `internal/account/${id}`

it.live("list returns empty when no accounts exist", () =>
  Effect.gen(function* () {
    const accounts = yield* AccountRepo.use.list()
    expect(accounts).toEqual([])
  }),
)

it.live("active returns none when no accounts exist", () =>
  Effect.gen(function* () {
    const active = yield* AccountRepo.use.active()
    expect(Option.isNone(active)).toBe(true)
  }),
)

it.live("persistAccount inserts and getRow retrieves", () =>
  Effect.gen(function* () {
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        remoteID: RemoteAccountID.make("user-1"),
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_123"),
        refreshToken: RefreshToken.make("rt_456"),
        expiry: Date.now() + 3600_000,
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )
    const id = yield* activeID()

    const row = yield* AccountRepo.use.getRow(id)
    expect(Option.isSome(row)).toBe(true)
    const value = Option.getOrThrow(row)
    expect(value.id).toBe(id)
    expect(value.remote_id).toBe(RemoteAccountID.make("user-1"))
    expect(value.email).toBe("test@example.com")

    const stored = yield* storedRow(id)
    expect(stored?.access_token).toStartWith("forge-secret:v1:")
    expect(stored?.refresh_token).toStartWith("forge-secret:v1:")
    expect(JSON.stringify(stored)).not.toContain("at_123")
    expect(JSON.stringify(stored)).not.toContain("rt_456")

    const active = yield* AccountRepo.use.active()
    expect(Option.getOrThrow(active).active_org_id).toBe(OrgID.make("org-1"))
  }),
)

it.live("persistAccount normalizes trailing slashes in stored server URLs", () =>
  Effect.gen(function* () {
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        remoteID: RemoteAccountID.make("user-1"),
        email: "test@example.com",
        url: "https://control.example.com/",
        accessToken: AccessToken.make("at_123"),
        refreshToken: RefreshToken.make("rt_456"),
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )
    const id = yield* activeID()

    const row = yield* AccountRepo.use.getRow(id)
    const active = yield* AccountRepo.use.active()
    const list = yield* AccountRepo.use.list()

    expect(Option.getOrThrow(row).url).toBe("https://control.example.com")
    expect(Option.getOrThrow(active).url).toBe("https://control.example.com")
    expect(list[0]?.url).toBe("https://control.example.com")
  }),
)

it.live("persistAccount sets the active account and org", () =>
  Effect.gen(function* () {
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        remoteID: RemoteAccountID.make("user-1"),
        email: "first@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + 3600_000,
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )
    const first = yield* activeID()

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        remoteID: RemoteAccountID.make("user-2"),
        email: "second@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_2"),
        refreshToken: RefreshToken.make("rt_2"),
        expiry: Date.now() + 3600_000,
        orgID: Option.some(OrgID.make("org-2")),
      }),
    )
    const second = yield* activeID()

    // Last persisted account is active with its org
    expect(second).not.toBe(first)
    const active = yield* AccountRepo.use.active()
    expect(Option.isSome(active)).toBe(true)
    expect(Option.getOrThrow(active).id).toBe(second)
    expect(Option.getOrThrow(active).active_org_id).toBe(OrgID.make("org-2"))
  }),
)

it.live("list returns all accounts", () =>
  Effect.gen(function* () {
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        remoteID: RemoteAccountID.make("user-1"),
        email: "a@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        remoteID: RemoteAccountID.make("user-2"),
        email: "b@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_2"),
        refreshToken: RefreshToken.make("rt_2"),
        expiry: Date.now() + 3600_000,
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )

    const accounts = yield* AccountRepo.use.list()
    expect(accounts.length).toBe(2)
    expect(accounts.map((a) => a.email).sort()).toEqual(["a@example.com", "b@example.com"])
  }),
)

it.live("remove deletes an account", () =>
  Effect.gen(function* () {
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        remoteID: RemoteAccountID.make("user-1"),
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )
    const id = yield* activeID()

    yield* AccountRepo.use.remove(id)

    const row = yield* AccountRepo.use.getRow(id)
    expect(Option.isNone(row)).toBe(true)
  }),
)

it.live("use stores the selected org and marks the account active", () =>
  Effect.gen(function* () {
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        remoteID: RemoteAccountID.make("user-1"),
        email: "first@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )
    const id1 = yield* activeID()

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        remoteID: RemoteAccountID.make("user-2"),
        email: "second@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_2"),
        refreshToken: RefreshToken.make("rt_2"),
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )

    yield* AccountRepo.Service.use((r) => r.use(id1, Option.some(OrgID.make("org-99"))))
    const active1 = yield* AccountRepo.use.active()
    expect(Option.getOrThrow(active1).id).toBe(id1)
    expect(Option.getOrThrow(active1).active_org_id).toBe(OrgID.make("org-99"))

    yield* AccountRepo.Service.use((r) => r.use(id1, Option.none()))
    const active2 = yield* AccountRepo.use.active()
    expect(Option.getOrThrow(active2).active_org_id).toBeNull()
  }),
)

it.live("persistToken updates token fields", () =>
  Effect.gen(function* () {
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        remoteID: RemoteAccountID.make("user-1"),
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("old_token"),
        refreshToken: RefreshToken.make("old_refresh"),
        expiry: 1000,
        orgID: Option.none(),
      }),
    )
    const id = yield* activeID()

    const expiry = Date.now() + 7200_000
    yield* AccountRepo.Service.use((r) =>
      r.persistToken({
        accountID: id,
        accessToken: AccessToken.make("new_token"),
        refreshToken: RefreshToken.make("new_refresh"),
        expiry: Option.some(expiry),
      }),
    )

    const row = yield* AccountRepo.use.getRow(id)
    const value = Option.getOrThrow(row)
    expect(value.access_token).toBe(AccessToken.make("new_token"))
    expect(value.refresh_token).toBe(RefreshToken.make("new_refresh"))
    expect(value.token_expiry).toBe(expiry)
  }),
)

it.live("persistToken with no expiry sets token_expiry to null", () =>
  Effect.gen(function* () {
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        remoteID: RemoteAccountID.make("user-1"),
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("old_token"),
        refreshToken: RefreshToken.make("old_refresh"),
        expiry: 1000,
        orgID: Option.none(),
      }),
    )
    const id = yield* activeID()

    yield* AccountRepo.Service.use((r) =>
      r.persistToken({
        accountID: id,
        accessToken: AccessToken.make("new_token"),
        refreshToken: RefreshToken.make("new_refresh"),
        expiry: Option.none(),
      }),
    )

    const row = yield* AccountRepo.use.getRow(id)
    expect(Option.getOrThrow(row).token_expiry).toBeNull()
  }),
)

it.live("persistAccount upserts on conflict", () =>
  Effect.gen(function* () {
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        remoteID: RemoteAccountID.make("user-1"),
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_v1"),
        refreshToken: RefreshToken.make("rt_v1"),
        expiry: 1000,
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )
    const id = yield* activeID()

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        remoteID: RemoteAccountID.make("user-1"),
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_v2"),
        refreshToken: RefreshToken.make("rt_v2"),
        expiry: 2000,
        orgID: Option.some(OrgID.make("org-2")),
      }),
    )

    const accounts = yield* AccountRepo.use.list()
    expect(accounts.length).toBe(1)
    expect(accounts[0]?.id).toBe(id)

    const row = yield* AccountRepo.use.getRow(id)
    const value = Option.getOrThrow(row)
    expect(value.access_token).toBe(AccessToken.make("at_v2"))

    const active = yield* AccountRepo.use.active()
    expect(Option.getOrThrow(active).active_org_id).toBe(OrgID.make("org-2"))
  }),
)

it.live("remove clears active state when deleting the active account", () =>
  Effect.gen(function* () {
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        remoteID: RemoteAccountID.make("user-1"),
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + 3600_000,
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )
    const id = yield* activeID()

    yield* AccountRepo.use.remove(id)

    const active = yield* AccountRepo.use.active()
    expect(Option.isNone(active)).toBe(true)
  }),
)

it.live("getRow returns none for nonexistent account", () =>
  Effect.gen(function* () {
    const row = yield* AccountRepo.Service.use((r) => r.getRow(AccountID.make("nope")))
    expect(Option.isNone(row)).toBe(true)
  }),
)

it.live("keys the row and the vault scope on a minted identity, not on the remote id", () =>
  Effect.gen(function* () {
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        remoteID: RemoteAccountID.make("user-1"),
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )
    const id = yield* activeID()

    expect(id).not.toBe("user-1")
    const stored = yield* storedRow(id)
    expect(stored?.remote_id).toBe(RemoteAccountID.make("user-1"))

    const opened = yield* SecretVault.Service.use((v) => v.open(scope(id), "access-token", stored!.access_token))
    expect(opened).toBe("at_1")
  }),
)

it.live("a reissued remote account id leaves the original row and its sealed tokens intact", () =>
  Effect.gen(function* () {
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        remoteID: RemoteAccountID.make("remote-before"),
        email: "user@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_before"),
        refreshToken: RefreshToken.make("rt_before"),
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )
    const original = yield* activeID()
    expect(original).not.toBe("remote-before")

    // The control plane reissues the user id for the same person.
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        remoteID: RemoteAccountID.make("remote-after"),
        email: "user@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_after"),
        refreshToken: RefreshToken.make("rt_after"),
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )
    const reissued = yield* activeID()
    expect(reissued).not.toBe(original)

    const before = yield* AccountRepo.use.getRow(original)
    expect(Option.getOrThrow(before).id).toBe(original)
    expect(Option.getOrThrow(before).access_token).toBe(AccessToken.make("at_before"))
    expect(Option.getOrThrow(before).refresh_token).toBe(RefreshToken.make("rt_before"))
    // The scope the original ciphertext was sealed under is derived from an
    // identity the control plane cannot move.
    const sealed = yield* storedRow(original)
    expect(sealed?.remote_id).toBe(RemoteAccountID.make("remote-before"))
    expect(yield* SecretVault.Service.use((v) => v.open(scope(original), "access-token", sealed!.access_token))).toBe(
      "at_before",
    )

    const after = yield* AccountRepo.use.getRow(reissued)
    expect(Option.getOrThrow(after).access_token).toBe(AccessToken.make("at_after"))

    // Re-authenticating under the original remote id still resolves to the
    // original row rather than minting a third identity.
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        remoteID: RemoteAccountID.make("remote-before"),
        email: "user@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_again"),
        refreshToken: RefreshToken.make("rt_again"),
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )
    expect(yield* activeID()).toBe(original)
    expect((yield* AccountRepo.use.list()).length).toBe(2)
    expect(Option.getOrThrow(yield* AccountRepo.use.getRow(original)).access_token).toBe(AccessToken.make("at_again"))
  }),
)

it.live("two servers issuing the same remote account id stay separate accounts", () =>
  Effect.gen(function* () {
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        remoteID: RemoteAccountID.make("user-1"),
        email: "one@example.com",
        url: "https://one.example.com",
        accessToken: AccessToken.make("at_one"),
        refreshToken: RefreshToken.make("rt_one"),
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )
    const one = yield* activeID()

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        remoteID: RemoteAccountID.make("user-1"),
        email: "two@example.com",
        url: "https://two.example.com",
        accessToken: AccessToken.make("at_two"),
        refreshToken: RefreshToken.make("rt_two"),
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )
    const two = yield* activeID()

    expect(two).not.toBe(one)
    expect((yield* AccountRepo.use.list()).length).toBe(2)
    expect(Option.getOrThrow(yield* AccountRepo.use.getRow(one)).access_token).toBe(AccessToken.make("at_one"))
    expect(Option.getOrThrow(yield* AccountRepo.use.getRow(one)).url).toBe("https://one.example.com")
    expect(Option.getOrThrow(yield* AccountRepo.use.getRow(two)).access_token).toBe(AccessToken.make("at_two"))
  }),
)

it.live("opens credentials sealed under a scope minted before the local identity existed", () =>
  Effect.gen(function* () {
    // Shape of a row migrated from the release that keyed `account.id` on the
    // control plane's user id: its tokens are sealed under that same value.
    const id = AccountID.make("user-legacy")
    const vault = yield* SecretVault.Service
    const access = yield* vault.seal(scope(id), "access-token", "at_legacy")
    const refresh = yield* vault.seal(scope(id), "refresh-token", "rt_legacy")
    yield* Database.Service.use((database) =>
      database.db
        .insert(AccountTable)
        .values({
          id,
          remote_id: RemoteAccountID.make("user-legacy"),
          email: "legacy@example.com",
          url: "https://control.example.com",
          access_token: access,
          refresh_token: refresh,
          token_expiry: Date.now() + 3600_000,
        })
        .run(),
    )

    const row = yield* AccountRepo.use.getRow(id)
    expect(Option.getOrThrow(row).access_token).toBe(AccessToken.make("at_legacy"))
    expect(Option.getOrThrow(row).refresh_token).toBe(RefreshToken.make("rt_legacy"))

    // Re-authenticating that account keeps the identity it was migrated with.
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        remoteID: RemoteAccountID.make("user-legacy"),
        email: "legacy@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_fresh"),
        refreshToken: RefreshToken.make("rt_fresh"),
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )
    expect(yield* activeID()).toBe(id)
    expect((yield* AccountRepo.use.list()).length).toBe(1)
  }),
)
