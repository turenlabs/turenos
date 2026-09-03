import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Credential } from "@turenlabs/core/credential"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Integration } from "@turenlabs/core/integration"
import { Database } from "@turenlabs/core/database/database"
import { CredentialTable } from "@turenlabs/core/credential/sql"
import { testEffect } from "./lib/effect"
import { eq } from "drizzle-orm"

const it = testEffect(LayerNode.compile(LayerNode.group([Credential.node, Database.node])))

describe("Credential", () => {
  it.effect("stores, updates, lists, and removes credentials", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const created = yield* credentials.create({
        integrationID,
        label: "Work",
        value: Credential.Key.make({ type: "key", key: "secret" }),
      })

      const stored = yield* Database.Service.use((database) =>
        database.db.select().from(CredentialTable).where(eq(CredentialTable.id, created.id)).get(),
      )
      expect(stored?.value).toStartWith("forge-secret:v1:")
      expect(JSON.stringify(stored)).not.toContain('"key":"secret"')

      expect(yield* credentials.list(integrationID)).toEqual([created])
      yield* credentials.update(created.id, { label: "Personal" })
      expect((yield* credentials.list(integrationID))[0]?.label).toBe("Personal")

      const replacement = yield* credentials.create({
        integrationID,
        label: "Replacement",
        value: Credential.Key.make({ type: "key", key: "replacement" }),
      })
      expect(yield* credentials.list(integrationID)).toEqual([replacement])

      yield* credentials.remove(replacement.id)
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )

  // models.dev renames and drops provider ids, and when it does the catalog stops registering
  // that integration — but the stored key is still the only copy the user has. Nothing here
  // consults the catalog, so a stranded credential stays stored, readable and enumerable, and
  // is reachable again the moment the id is registered by upstream, a plugin or the user's own
  // config. That reversibility is why an upstream rename is a nuisance rather than data loss;
  // a pruner that swept credentials for "unknown" integrations would quietly make it one.
  it.effect("keeps credentials for an integration the catalog no longer registers", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const stranded = Integration.ID.make("github-models")
      const orphan = yield* credentials.create({
        integrationID: stranded,
        value: Credential.Key.make({ type: "key", key: "stranded" }),
      })

      // Replacement is the only path that deletes rows, and it is scoped to one integration.
      yield* credentials.create({
        integrationID: Integration.ID.make("anthropic"),
        value: Credential.Key.make({ type: "key", key: "live" }),
      })

      expect((yield* credentials.all()).map((item) => item.id)).toContain(orphan.id)
      expect(yield* credentials.get(orphan.id)).toEqual(orphan)
      expect(yield* credentials.list(stranded)).toEqual([orphan])
    }),
  )
})
