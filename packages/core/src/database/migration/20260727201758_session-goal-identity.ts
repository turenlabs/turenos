import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260727201758_session-goal-identity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_goal_identity\` (
          \`goal_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`message_id\` text UNIQUE,
          \`objective\` text NOT NULL,
          \`token_budget\` integer,
          \`state\` text NOT NULL,
          \`final_revision\` integer,
          \`time_created\` integer NOT NULL,
          \`time_terminal\` integer,
          CONSTRAINT \`fk_session_goal_identity_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE INDEX \`session_goal_identity_session_idx\` ON \`session_goal_identity\` (\`session_id\`);
      `)
      const duplicateGoal = yield* tx.get<{ id: string }>(`
        SELECT json_extract(data, '$.goal.id') AS id
        FROM event
        WHERE type = 'session.next.goal.updated.1'
          AND json_extract(data, '$.goal.revision') = 1
        GROUP BY id
        HAVING count(*) > 1
        LIMIT 1;
      `)
      if (duplicateGoal)
        return yield* Effect.fail(
          new Error(`Duplicate durable Session goal identity requires repair: ${duplicateGoal.id}`),
        )
      const duplicateMessage = yield* tx.get<{ id: string }>(`
        SELECT json_extract(data, '$.admission.messageID') AS id
        FROM event
        WHERE type = 'session.next.goal.updated.1'
          AND json_extract(data, '$.goal.revision') = 1
          AND json_type(data, '$.admission.messageID') = 'text'
        GROUP BY id
        HAVING count(*) > 1
        LIMIT 1;
      `)
      if (duplicateMessage)
        return yield* Effect.fail(
          new Error(`Duplicate durable Session goal message identity requires repair: ${duplicateMessage.id}`),
        )
      const invalidRevision = yield* tx.get<{ id: string }>(`
        WITH revision(id, session_id, payload_session_id, revision) AS (
          SELECT
            json_extract(data, '$.goal.id'),
            aggregate_id,
            json_extract(data, '$.goal.sessionID'),
            json_extract(data, '$.goal.revision')
          FROM event
          WHERE type = 'session.next.goal.updated.1'
        )
        SELECT id
        FROM revision
        GROUP BY id
        HAVING min(revision) <> 1
          OR count(*) <> max(revision)
          OR count(DISTINCT revision) <> count(*)
          OR count(DISTINCT session_id) <> 1
          OR sum(CASE WHEN session_id <> payload_session_id THEN 1 ELSE 0 END) <> 0
        LIMIT 1;
      `)
      if (invalidRevision)
        return yield* Effect.fail(
          new Error(`Invalid durable Session goal revision history requires repair: ${invalidRevision.id}`),
        )
      yield* tx.run(`
        INSERT OR IGNORE INTO \`session_goal\` (
          \`session_id\`,
          \`goal_id\`,
          \`revision\`,
          \`objective\`,
          \`status\`,
          \`token_budget\`,
          \`tokens_used\`,
          \`active_time_ms\`,
          \`status_changed_at\`,
          \`time_created\`,
          \`time_updated\`,
          \`time_completed\`
        )
        SELECT
          event.aggregate_id,
          json_extract(event.data, '$.goal.id'),
          json_extract(event.data, '$.goal.revision'),
          json_extract(event.data, '$.goal.objective'),
          json_extract(event.data, '$.goal.status'),
          json_extract(event.data, '$.goal.tokenBudget'),
          json_extract(event.data, '$.goal.tokensUsed'),
          json_extract(event.data, '$.activeTimeMs'),
          json_extract(event.data, '$.goal.time.statusChanged'),
          json_extract(event.data, '$.goal.time.created'),
          json_extract(event.data, '$.goal.time.updated'),
          json_extract(event.data, '$.goal.time.completed')
        FROM event
        WHERE event.type = 'session.next.goal.updated.1'
          AND event.seq = (
            SELECT max(lifecycle.seq)
            FROM event AS lifecycle
            WHERE lifecycle.aggregate_id = event.aggregate_id
              AND lifecycle.type IN (
                'session.next.goal.updated.1',
                'session.next.goal.cleared.1'
              )
          );
      `)
      yield* tx.run(`
        WITH creation AS (
          SELECT
            event.aggregate_id AS session_id,
            event.seq,
            json_extract(event.data, '$.goal.id') AS goal_id,
            json_extract(event.data, '$.admission.messageID') AS message_id,
            json_extract(event.data, '$.goal.objective') AS objective,
            json_extract(event.data, '$.goal.tokenBudget') AS token_budget,
            json_extract(event.data, '$.goal.time.created') AS time_created,
            (
              SELECT min(cleared.seq)
              FROM event AS cleared
              WHERE cleared.aggregate_id = event.aggregate_id
                AND cleared.type = 'session.next.goal.cleared.1'
                AND json_extract(cleared.data, '$.goalID') = json_extract(event.data, '$.goal.id')
                AND cleared.seq > event.seq
            ) AS cleared_seq,
            (
              SELECT min(replacement.seq)
              FROM event AS replacement
              WHERE replacement.aggregate_id = event.aggregate_id
                AND replacement.type = 'session.next.goal.updated.1'
                AND json_extract(replacement.data, '$.goal.revision') = 1
                AND json_extract(replacement.data, '$.goal.id') <> json_extract(event.data, '$.goal.id')
                AND replacement.seq > event.seq
            ) AS replacement_seq
          FROM event
          WHERE event.type = 'session.next.goal.updated.1'
            AND json_extract(event.data, '$.goal.revision') = 1
        ),
        resolved AS (
          SELECT
            creation.*,
            CASE
              WHEN cleared_seq IS NOT NULL
                AND (replacement_seq IS NULL OR cleared_seq < replacement_seq)
                THEN 'cleared'
              WHEN replacement_seq IS NOT NULL THEN 'replaced'
              ELSE 'current'
            END AS state,
            CASE
              WHEN cleared_seq IS NOT NULL
                AND (replacement_seq IS NULL OR cleared_seq < replacement_seq)
                THEN (
                  SELECT json_extract(cleared.data, '$.revision')
                  FROM event AS cleared
                  WHERE cleared.aggregate_id = creation.session_id
                    AND cleared.seq = creation.cleared_seq
                )
              WHEN replacement_seq IS NOT NULL THEN (
                SELECT max(json_extract(updated.data, '$.goal.revision'))
                FROM event AS updated
                WHERE updated.aggregate_id = creation.session_id
                  AND updated.type = 'session.next.goal.updated.1'
                  AND json_extract(updated.data, '$.goal.id') = creation.goal_id
                  AND updated.seq < creation.replacement_seq
              )
              ELSE NULL
            END AS final_revision,
            CASE
              WHEN cleared_seq IS NOT NULL
                AND (replacement_seq IS NULL OR cleared_seq < replacement_seq)
                THEN (
                  SELECT json_extract(cleared.data, '$.timestamp')
                  FROM event AS cleared
                  WHERE cleared.aggregate_id = creation.session_id
                    AND cleared.seq = creation.cleared_seq
                )
              WHEN replacement_seq IS NOT NULL THEN (
                SELECT json_extract(replacement.data, '$.timestamp')
                FROM event AS replacement
                WHERE replacement.aggregate_id = creation.session_id
                  AND replacement.seq = creation.replacement_seq
              )
              ELSE NULL
            END AS time_terminal
          FROM creation
        )
        INSERT INTO \`session_goal_identity\` (
          \`goal_id\`,
          \`session_id\`,
          \`message_id\`,
          \`objective\`,
          \`token_budget\`,
          \`state\`,
          \`final_revision\`,
          \`time_created\`,
          \`time_terminal\`
        )
        SELECT
          resolved.goal_id,
          resolved.session_id,
          resolved.message_id,
          resolved.objective,
          resolved.token_budget,
          resolved.state,
          resolved.final_revision,
          resolved.time_created,
          resolved.time_terminal
        FROM resolved;
      `)
      yield* tx.run(`
        INSERT OR IGNORE INTO \`session_goal_identity\` (
          \`goal_id\`,
          \`session_id\`,
          \`objective\`,
          \`token_budget\`,
          \`state\`,
          \`time_created\`
        )
        SELECT
          \`goal_id\`,
          \`session_id\`,
          \`objective\`,
          \`token_budget\`,
          'current',
          \`time_created\`
        FROM \`session_goal\`;
      `)
      const creationConflict = yield* tx.get<{ id: string }>(`
        SELECT json_extract(event.data, '$.goal.id') AS id
        FROM event
        INNER JOIN session_goal_identity AS identity
          ON identity.goal_id = json_extract(event.data, '$.goal.id')
        WHERE event.type = 'session.next.goal.updated.1'
          AND json_extract(event.data, '$.goal.revision') = 1
          AND (
            identity.session_id <> event.aggregate_id
            OR identity.message_id IS NOT json_extract(event.data, '$.admission.messageID')
            OR identity.objective <> json_extract(event.data, '$.goal.objective')
            OR identity.token_budget IS NOT json_extract(event.data, '$.goal.tokenBudget')
            OR identity.time_created <> json_extract(event.data, '$.goal.time.created')
          )
        LIMIT 1;
      `)
      if (creationConflict)
        return yield* Effect.fail(new Error(`Historical Session goal identity requires repair: ${creationConflict.id}`))
      const currentConflict = yield* tx.get<{ id: string }>(`
        SELECT goal.goal_id AS id
        FROM session_goal AS goal
        INNER JOIN session_goal_identity AS identity ON identity.goal_id = goal.goal_id
        WHERE identity.session_id <> goal.session_id
          OR identity.state <> 'current'
        LIMIT 1;
      `)
      if (currentConflict)
        return yield* Effect.fail(new Error(`Current Session goal projection requires repair: ${currentConflict.id}`))
      const currentProjectionConflict = yield* tx.get<{ id: string }>(`
        WITH latest AS (
          SELECT event.*
          FROM event
          WHERE event.type = 'session.next.goal.updated.1'
            AND event.seq = (
              SELECT max(lifecycle.seq)
              FROM event AS lifecycle
              WHERE lifecycle.aggregate_id = event.aggregate_id
                AND lifecycle.type IN (
                  'session.next.goal.updated.1',
                  'session.next.goal.cleared.1'
                )
            )
        )
        SELECT goal.goal_id AS id
        FROM session_goal AS goal
        LEFT JOIN latest ON latest.aggregate_id = goal.session_id
        WHERE latest.id IS NULL
          OR goal.goal_id IS NOT json_extract(latest.data, '$.goal.id')
          OR goal.revision IS NOT json_extract(latest.data, '$.goal.revision')
          OR goal.objective IS NOT json_extract(latest.data, '$.goal.objective')
          OR goal.status IS NOT json_extract(latest.data, '$.goal.status')
          OR goal.token_budget IS NOT json_extract(latest.data, '$.goal.tokenBudget')
          OR goal.tokens_used IS NOT json_extract(latest.data, '$.goal.tokensUsed')
          OR goal.active_time_ms IS NOT json_extract(latest.data, '$.activeTimeMs')
          OR goal.status_changed_at IS NOT json_extract(latest.data, '$.goal.time.statusChanged')
          OR goal.time_created IS NOT json_extract(latest.data, '$.goal.time.created')
          OR goal.time_updated IS NOT json_extract(latest.data, '$.goal.time.updated')
          OR goal.time_completed IS NOT json_extract(latest.data, '$.goal.time.completed')
        LIMIT 1;
      `)
      if (currentProjectionConflict)
        return yield* Effect.fail(
          new Error(`Current Session goal event projection requires repair: ${currentProjectionConflict.id}`),
        )
    })
  },
} satisfies DatabaseMigration.Migration
