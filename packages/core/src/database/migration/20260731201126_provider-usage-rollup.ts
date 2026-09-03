import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260731201126_provider-usage-rollup",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`provider_usage\` (
          \`session_id\` text NOT NULL,
          \`assistant_message_id\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`time\` integer NOT NULL,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          CONSTRAINT \`provider_usage_pk\` PRIMARY KEY(\`session_id\`, \`assistant_message_id\`),
          CONSTRAINT \`fk_provider_usage_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`provider_usage_time_idx\` ON \`provider_usage\` (\`time\`);`)
      // Backfill from projected assistant messages, not the durable start/end
      // event pair. A reverted assistant message has already been removed, so
      // it cannot be reintroduced into usage; the primary key lookup is also
      // linear instead of one JSON comparison per historical turn pair.
      yield* tx.run(`
        INSERT INTO \`provider_usage\` (
          \`session_id\`, \`assistant_message_id\`, \`provider_id\`, \`time\`, \`cost\`,
          \`tokens_input\`, \`tokens_output\`, \`tokens_reasoning\`, \`tokens_cache_read\`, \`tokens_cache_write\`
        )
        SELECT
          ended.\`aggregate_id\`,
          json_extract(ended.\`data\`, '$.assistantMessageID'),
          json_extract(message.\`data\`, '$.model.providerID'),
          json_extract(ended.\`data\`, '$.timestamp'),
          coalesce(cast(json_extract(ended.\`data\`, '$.cost') as real), 0),
          coalesce(cast(coalesce(json_extract(ended.\`data\`, '$.billed.input'), json_extract(ended.\`data\`, '$.tokens.input')) as integer), 0),
          coalesce(cast(coalesce(json_extract(ended.\`data\`, '$.billed.output'), json_extract(ended.\`data\`, '$.tokens.output')) as integer), 0),
          coalesce(cast(coalesce(json_extract(ended.\`data\`, '$.billed.reasoning'), json_extract(ended.\`data\`, '$.tokens.reasoning')) as integer), 0),
          coalesce(cast(coalesce(json_extract(ended.\`data\`, '$.billed.cache.read'), json_extract(ended.\`data\`, '$.tokens.cache.read')) as integer), 0),
          coalesce(cast(coalesce(json_extract(ended.\`data\`, '$.billed.cache.write'), json_extract(ended.\`data\`, '$.tokens.cache.write')) as integer), 0)
        FROM \`event\` AS ended
        INNER JOIN \`session_message\` AS message
          ON message.\`session_id\` = ended.\`aggregate_id\`
          AND message.\`id\` = json_extract(ended.\`data\`, '$.assistantMessageID')
          AND message.\`type\` = 'assistant'
        WHERE ended.\`type\` = 'session.next.step.ended.2'
          AND json_valid(ended.\`data\`)
          AND json_extract(ended.\`data\`, '$.assistantMessageID') IS NOT NULL
          AND json_extract(message.\`data\`, '$.model.providerID') IS NOT NULL;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
