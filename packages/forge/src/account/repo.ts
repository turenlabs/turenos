import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { and, eq } from "drizzle-orm"
import { serviceUse } from "@turenlabs/core/effect/service-use"
import { Effect, Layer, Option, Schema, Context } from "effect"

import { Database } from "@turenlabs/core/database/database"
import { AccountStateTable, AccountTable, ControlAccountTable } from "@turenlabs/core/account/sql"
import { SecretVault } from "@turenlabs/core/secret-vault"
import { Identifier } from "@/id/id"
import { AccessToken, AccountID, AccountRepoError, Info, OrgID, RefreshToken, RemoteAccountID } from "./schema"
import { normalizeServerUrl } from "./url"

type StoredAccountRow = (typeof AccountTable)["$inferSelect"]
export type AccountRow = Omit<StoredAccountRow, "access_token" | "refresh_token"> & {
  access_token: AccessToken
  refresh_token: RefreshToken
}

const ACCOUNT_STATE_ID = 1

export interface Interface {
  readonly active: () => Effect.Effect<Option.Option<Info>, AccountRepoError>
  readonly list: () => Effect.Effect<Info[], AccountRepoError>
  readonly remove: (accountID: AccountID) => Effect.Effect<void, AccountRepoError>
  readonly use: (accountID: AccountID, orgID: Option.Option<OrgID>) => Effect.Effect<void, AccountRepoError>
  readonly getRow: (accountID: AccountID) => Effect.Effect<Option.Option<AccountRow>, AccountRepoError>
  readonly persistToken: (input: {
    accountID: AccountID
    accessToken: AccessToken
    refreshToken: RefreshToken
    expiry: Option.Option<number>
  }) => Effect.Effect<void, AccountRepoError>
  readonly persistAccount: (input: {
    remoteID: RemoteAccountID
    email: string
    url: string
    accessToken: AccessToken
    refreshToken: RefreshToken
    expiry: number
    orgID: Option.Option<OrgID>
  }) => Effect.Effect<void, AccountRepoError>
}

export class Service extends Context.Service<Service, Interface>()("@forge/AccountRepo") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const vault = yield* SecretVault.Service
    const decode = Schema.decodeUnknownSync(Info)

    const query = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.mapError((cause) => new AccountRepoError({ message: "Database operation failed", cause })))

    yield* query(
      db.transaction((tx) =>
        Effect.gen(function* () {
          const accounts = yield* tx.select().from(AccountTable).all()
          yield* Effect.forEach(
            accounts.filter((row) => !vault.isSealed(row.access_token) || !vault.isSealed(row.refresh_token)),
            (row) =>
              Effect.gen(function* () {
                const tokens = yield* sealTokens(vault, accountScope(row.id), row)
                yield* tx.update(AccountTable).set(tokens).where(eq(AccountTable.id, row.id)).run()
              }),
            { concurrency: 1, discard: true },
          )

          const legacy = yield* tx.select().from(ControlAccountTable).all()
          yield* Effect.forEach(
            legacy.filter((row) => !vault.isSealed(row.access_token) || !vault.isSealed(row.refresh_token)),
            (row) =>
              Effect.gen(function* () {
                const scope = `internal/control-account/${row.email}/${row.url}`
                const tokens = yield* sealTokens(vault, scope, row)
                yield* tx
                  .update(ControlAccountTable)
                  .set(tokens)
                  .where(and(eq(ControlAccountTable.email, row.email), eq(ControlAccountTable.url, row.url)))
                  .run()
              }),
            { concurrency: 1, discard: true },
          )
        }),
      ),
    ).pipe(Effect.orDie)

    const current = Effect.fnUntraced(function* () {
      const state = yield* db.select().from(AccountStateTable).where(eq(AccountStateTable.id, ACCOUNT_STATE_ID)).get()
      if (!state?.active_account_id) return
      const account = yield* db.select().from(AccountTable).where(eq(AccountTable.id, state.active_account_id)).get()
      if (!account) return
      return { ...(yield* openRow(vault, account)), active_org_id: state.active_org_id ?? null }
    })

    const state = (accountID: AccountID, orgID: Option.Option<OrgID>) => {
      const id = Option.getOrNull(orgID)
      return db
        .insert(AccountStateTable)
        .values({ id: ACCOUNT_STATE_ID, active_account_id: accountID, active_org_id: id })
        .onConflictDoUpdate({
          target: AccountStateTable.id,
          set: { active_account_id: accountID, active_org_id: id },
        })
        .run()
    }

    const active = Effect.fn("AccountRepo.active")(() =>
      query(current()).pipe(Effect.map((row) => (row ? Option.some(decode(row)) : Option.none()))),
    )

    const list = Effect.fn("AccountRepo.list")(() =>
      query(
        db
          .select()
          .from(AccountTable)
          .all()
          .pipe(
            Effect.flatMap((rows) => Effect.forEach(rows, (row: StoredAccountRow) => openRow(vault, row))),
            Effect.map((rows) => rows.map((row) => decode({ ...row, active_org_id: null }))),
          ),
      ),
    )

    const remove = Effect.fn("AccountRepo.remove")((accountID: AccountID) =>
      query(
        db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(AccountStateTable)
              .set({ active_account_id: null, active_org_id: null })
              .where(eq(AccountStateTable.active_account_id, accountID))
              .run()
            yield* tx.delete(AccountTable).where(eq(AccountTable.id, accountID)).run()
          }),
        ),
      ).pipe(Effect.asVoid),
    )

    const use = Effect.fn("AccountRepo.use")((accountID: AccountID, orgID: Option.Option<OrgID>) =>
      query(state(accountID, orgID)).pipe(Effect.asVoid),
    )

    const getRow = Effect.fn("AccountRepo.getRow")((accountID: AccountID) =>
      query(
        db
          .select()
          .from(AccountTable)
          .where(eq(AccountTable.id, accountID))
          .get()
          .pipe(Effect.flatMap((row) => (row ? openRow(vault, row) : Effect.succeed(undefined)))),
      ).pipe(Effect.map(Option.fromNullishOr)),
    )

    const persistToken = Effect.fn("AccountRepo.persistToken")((input) =>
      query(
        Effect.gen(function* () {
          const accessToken = yield* vault.seal(accountScope(input.accountID), "access-token", input.accessToken)
          const refreshToken = yield* vault.seal(accountScope(input.accountID), "refresh-token", input.refreshToken)
          yield* db
            .update(AccountTable)
            .set({
              access_token: accessToken,
              refresh_token: refreshToken,
              token_expiry: Option.getOrNull(input.expiry),
            })
            .where(eq(AccountTable.id, input.accountID))
            .run()
        }),
      ).pipe(Effect.asVoid),
    )

    const persistAccount = Effect.fn("AccountRepo.persistAccount")((input) =>
      query(
        db.transaction((tx) =>
          Effect.gen(function* () {
            const url = normalizeServerUrl(input.url)
            // An identity we already hold always wins. The control plane's user
            // id is not ours: a tenant migration, an account merge, or an SSO
            // re-provision reissues it, and because that id would otherwise be
            // both our primary key and `accountScope`, the reissue would split
            // one account across two rows and move the HKDF-derived key and the
            // AEAD additional data out from under every token already sealed
            // for it. That is not "log in again", that is ciphertext with no
            // key. The remote id may only *find* an account we have already
            // claimed; the identity we mint here is the one that persists.
            const existing = yield* tx
              .select({ id: AccountTable.id })
              .from(AccountTable)
              .where(and(eq(AccountTable.url, url), eq(AccountTable.remote_id, input.remoteID)))
              .get()
            const id = existing?.id ?? AccountID.make(Identifier.create("acc", "ascending"))
            const accessToken = yield* vault.seal(accountScope(id), "access-token", input.accessToken)
            const refreshToken = yield* vault.seal(accountScope(id), "refresh-token", input.refreshToken)

            yield* tx
              .insert(AccountTable)
              .values({
                id,
                remote_id: input.remoteID,
                email: input.email,
                url,
                access_token: accessToken,
                refresh_token: refreshToken,
                token_expiry: input.expiry,
              })
              .onConflictDoUpdate({
                target: AccountTable.id,
                set: {
                  remote_id: input.remoteID,
                  email: input.email,
                  url,
                  access_token: accessToken,
                  refresh_token: refreshToken,
                  token_expiry: input.expiry,
                },
              })
              .run()
            yield* state(id, input.orgID)
          }),
        ),
      ).pipe(Effect.asVoid),
    )

    return Service.of({
      active,
      list,
      remove,
      use,
      getRow,
      persistToken,
      persistAccount,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Database.node, SecretVault.node] })

function accountScope(accountID: string) {
  return `internal/account/${accountID}`
}

const sealTokens = Effect.fn("AccountRepo.sealTokens")(function* (
  vault: SecretVault.Interface,
  scope: string,
  row: { access_token: string; refresh_token: string },
) {
  return {
    access_token: vault.isSealed(row.access_token)
      ? row.access_token
      : yield* vault.seal(scope, "access-token", row.access_token),
    refresh_token: vault.isSealed(row.refresh_token)
      ? row.refresh_token
      : yield* vault.seal(scope, "refresh-token", row.refresh_token),
  }
})

const openRow = Effect.fn("AccountRepo.openRow")(function* (vault: SecretVault.Interface, row: StoredAccountRow) {
  return {
    ...row,
    access_token: AccessToken.make(
      vault.isSealed(row.access_token)
        ? yield* vault.open(accountScope(row.id), "access-token", row.access_token)
        : row.access_token,
    ),
    refresh_token: RefreshToken.make(
      vault.isSealed(row.refresh_token)
        ? yield* vault.open(accountScope(row.id), "refresh-token", row.refresh_token)
        : row.refresh_token,
    ),
  }
})

export * as AccountRepo from "./repo"
