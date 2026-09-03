import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260803175613_account_remote_id",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`account\` ADD \`remote_id\` text DEFAULT '' NOT NULL;`)
      // Every existing row was keyed on the control plane's user id, and its
      // access and refresh tokens are sealed under `internal/account/<id>`,
      // which is both HKDF-derived and authenticated into the ciphertext. So
      // the remote id moves into `remote_id` while `id` keeps the exact value
      // it already had: the scope stays byte-identical and nothing has to be
      // unsealed and resealed to keep this install logged in.
      yield* tx.run(`UPDATE \`account\` SET \`remote_id\` = \`id\`;`)
      // Rows written before server URLs were normalized on write would miss the
      // (url, remote_id) lookup and mint a duplicate account on next login.
      yield* tx.run(`UPDATE \`account\` SET \`url\` = rtrim(\`url\`, '/') WHERE \`url\` <> rtrim(\`url\`, '/');`)
      yield* tx.run(`CREATE UNIQUE INDEX \`account_url_remote_idx\` ON \`account\` (\`url\`,\`remote_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
