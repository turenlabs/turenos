import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260727204640_session-message-identity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_message_identity\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`owner\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`input\` text,
          \`state\` text NOT NULL,
          \`creator_seq\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_message_identity_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_message_identity_session_idx\` ON \`session_message_identity\` (\`session_id\`);`,
      )
      const projectedCollision = yield* tx.get<{ id: string }>(`
        SELECT input.id
        FROM session_input AS input
        INNER JOIN session_message AS message ON message.id = input.id
        WHERE message.session_id <> input.session_id OR message.type <> 'user'
        LIMIT 1;
      `)
      if (projectedCollision)
        return yield* Effect.fail(
          new Error(`Session message identity collision requires repair: ${projectedCollision.id}`),
        )
      const duplicateAdmission = yield* tx.get<{ id: string }>(`
        WITH admission(id) AS (
          SELECT json_extract(data, '$.messageID')
          FROM event
          WHERE type = 'session.next.prompt.admitted.1'
          UNION ALL
          SELECT json_extract(data, '$.admission.messageID')
          FROM event
          WHERE type = 'session.next.goal.updated.1'
            AND json_type(data, '$.admission.messageID') = 'text'
        )
        SELECT id
        FROM admission
        GROUP BY id
        HAVING count(*) > 1
        LIMIT 1;
      `)
      if (duplicateAdmission)
        return yield* Effect.fail(
          new Error(`Duplicate durable Session admission requires repair: ${duplicateAdmission.id}`),
        )
      const duplicatePrompted = yield* tx.get<{ id: string }>(`
        SELECT json_extract(data, '$.messageID') AS id
        FROM event
        WHERE type = 'session.next.prompted.1'
        GROUP BY id
        HAVING count(*) > 1
        LIMIT 1;
      `)
      if (duplicatePrompted)
        return yield* Effect.fail(
          new Error(`Duplicate durable Session promotion requires repair: ${duplicatePrompted.id}`),
        )
      const promptedAdmissionConflict = yield* tx.get<{ id: string }>(`
        WITH admission(id, session_id, prompt, delivery) AS (
          SELECT
            json_extract(data, '$.messageID'),
            aggregate_id,
            json_extract(data, '$.prompt'),
            json_extract(data, '$.delivery')
          FROM event
          WHERE type = 'session.next.prompt.admitted.1'
          UNION ALL
          SELECT
            json_extract(data, '$.admission.messageID'),
            aggregate_id,
            json_extract(data, '$.admission.prompt'),
            json_extract(data, '$.admission.delivery')
          FROM event
          WHERE type = 'session.next.goal.updated.1'
            AND json_type(data, '$.admission.messageID') = 'text'
        )
        SELECT json_extract(prompted.data, '$.messageID') AS id
        FROM event AS prompted
        INNER JOIN admission ON admission.id = json_extract(prompted.data, '$.messageID')
        WHERE prompted.type = 'session.next.prompted.1'
          AND (
            admission.session_id <> prompted.aggregate_id
            OR json(admission.prompt) <> json(json_extract(prompted.data, '$.prompt'))
            OR admission.delivery <> json_extract(prompted.data, '$.delivery')
          )
        LIMIT 1;
      `)
      if (promptedAdmissionConflict)
        return yield* Effect.fail(
          new Error(`Durable Session promotion conflicts with admission: ${promptedAdmissionConflict.id}`),
        )
      const duplicateClaim = yield* tx.get<{ id: string }>(`
        WITH admission(id) AS (
          SELECT json_extract(data, '$.messageID')
          FROM event
          WHERE type = 'session.next.prompt.admitted.1'
          UNION ALL
          SELECT json_extract(data, '$.admission.messageID')
          FROM event
          WHERE type = 'session.next.goal.updated.1'
            AND json_type(data, '$.admission.messageID') = 'text'
        ),
        claim(id) AS (
          SELECT id
          FROM admission
          UNION ALL
          SELECT json_extract(prompted.data, '$.messageID')
          FROM event AS prompted
          WHERE prompted.type = 'session.next.prompted.1'
            AND NOT EXISTS (
              SELECT 1
              FROM admission
              WHERE admission.id = json_extract(prompted.data, '$.messageID')
            )
          UNION ALL
          SELECT
            CASE
              WHEN type = 'session.next.step.started.1' THEN json_extract(data, '$.assistantMessageID')
              ELSE json_extract(data, '$.messageID')
            END
          FROM event
          WHERE type IN (
            'session.next.agent.switched.1',
            'session.next.model.switched.1',
            'session.next.context.updated.1',
            'session.next.synthetic.1',
            'session.next.shell.started.1',
            'session.next.step.started.1',
            'session.next.compaction.ended.1'
          )
        )
        SELECT id
        FROM claim
        WHERE id IS NOT NULL
        GROUP BY id
        HAVING count(*) > 1
        LIMIT 1;
      `)
      if (duplicateClaim)
        return yield* Effect.fail(
          new Error(`Duplicate durable Session message identity requires repair: ${duplicateClaim.id}`),
        )
      const historicalProjectionCollision = yield* tx.get<{ id: string }>(`
        WITH admission(id, session_id) AS (
          SELECT json_extract(data, '$.messageID'), aggregate_id
          FROM event
          WHERE type IN (
            'session.next.prompt.admitted.1',
            'session.next.prompted.1'
          )
          UNION ALL
          SELECT json_extract(data, '$.admission.messageID'), aggregate_id
          FROM event
          WHERE type = 'session.next.goal.updated.1'
            AND json_type(data, '$.admission.messageID') = 'text'
        )
        SELECT admission.id
        FROM admission
        INNER JOIN session_message AS message ON message.id = admission.id
        WHERE message.session_id <> admission.session_id OR message.type <> 'user'
        LIMIT 1;
      `)
      if (historicalProjectionCollision)
        return yield* Effect.fail(
          new Error(`Historical Session admission projection requires repair: ${historicalProjectionCollision.id}`),
        )
      yield* tx.run(`
        INSERT INTO session_message_identity (
          id,
          session_id,
          owner,
          kind,
          input,
          state,
          time_created
        )
        SELECT
          input.id,
          input.session_id,
          'input',
          CASE
            WHEN goal.message_id IS NOT NULL THEN 'goal'
            WHEN input.command IS NOT NULL THEN 'command'
            ELSE 'prompt'
          END,
          json_patch(
            json_object(
              'admitted',
              json_patch(
                json_patch(
                  json_object(
                    'admittedSeq', input.admitted_seq,
                    'id', input.id,
                    'sessionID', input.session_id,
                    'prompt', json(input.prompt),
                    'delivery', input.delivery,
                    'timeCreated', input.time_created
                  ),
                  CASE
                    WHEN input.agent IS NULL THEN json_object()
                    ELSE json_object('agent', input.agent)
                  END
                ),
                CASE
                  WHEN input.model IS NULL THEN json_object()
                  ELSE json_object('model', json(input.model))
                END
              )
            ),
            CASE
              WHEN input.command IS NULL THEN json_object()
              ELSE json_object('command', json(input.command))
            END
          ),
          'active',
          input.time_created
        FROM session_input AS input
        LEFT JOIN session_goal_identity AS goal ON goal.message_id = input.id;
      `)
      yield* tx.run(`
        INSERT OR IGNORE INTO session_message_identity (
          id,
          session_id,
          owner,
          kind,
          input,
          state,
          time_created
        )
        SELECT
          json_extract(event.data, '$.messageID'),
          event.aggregate_id,
          'input',
          CASE WHEN json_type(event.data, '$.command') IS NULL THEN 'prompt' ELSE 'command' END,
          json_patch(
            json_object(
              'admitted',
              json_patch(
                json_patch(
                  json_object(
                    'admittedSeq', event.seq,
                    'id', json_extract(event.data, '$.messageID'),
                    'sessionID', event.aggregate_id,
                    'prompt', json(json_extract(event.data, '$.prompt')),
                    'delivery', json_extract(event.data, '$.delivery'),
                    'timeCreated', json_extract(event.data, '$.timestamp')
                  ),
                  CASE
                    WHEN json_type(event.data, '$.agent') IS NULL THEN json_object()
                    ELSE json_object('agent', json_extract(event.data, '$.agent'))
                  END
                ),
                CASE
                  WHEN json_type(event.data, '$.model') IS NULL THEN json_object()
                  ELSE json_object('model', json(json_extract(event.data, '$.model')))
                END
              )
            ),
            CASE
              WHEN json_type(event.data, '$.command') IS NULL THEN json_object()
              ELSE json_object('command', json(json_extract(event.data, '$.command')))
            END
          ),
          CASE WHEN input.id IS NULL AND message.id IS NULL THEN 'reverted' ELSE 'active' END,
          json_extract(event.data, '$.timestamp')
        FROM event
        LEFT JOIN session_input AS input ON input.id = json_extract(event.data, '$.messageID')
        LEFT JOIN session_message AS message
          ON message.id = json_extract(event.data, '$.messageID')
          AND message.session_id = event.aggregate_id
          AND message.type = 'user'
        WHERE event.type = 'session.next.prompt.admitted.1';
      `)
      yield* tx.run(`
        INSERT OR IGNORE INTO session_message_identity (
          id,
          session_id,
          owner,
          kind,
          input,
          state,
          time_created
        )
        SELECT
          json_extract(event.data, '$.admission.messageID'),
          event.aggregate_id,
          'input',
          'goal',
          json_object(
            'admitted',
            json_patch(
              json_patch(
                json_object(
                  'admittedSeq', event.seq,
                  'id', json_extract(event.data, '$.admission.messageID'),
                  'sessionID', event.aggregate_id,
                  'prompt', json(json_extract(event.data, '$.admission.prompt')),
                  'delivery', json_extract(event.data, '$.admission.delivery'),
                  'timeCreated', json_extract(event.data, '$.timestamp')
                ),
                CASE
                  WHEN json_type(event.data, '$.admission.agent') IS NULL THEN json_object()
                  ELSE json_object('agent', json_extract(event.data, '$.admission.agent'))
                END
              ),
              CASE
                WHEN json_type(event.data, '$.admission.model') IS NULL THEN json_object()
                ELSE json_object('model', json(json_extract(event.data, '$.admission.model')))
              END
            )
          ),
          CASE WHEN input.id IS NULL AND message.id IS NULL THEN 'reverted' ELSE 'active' END,
          json_extract(event.data, '$.timestamp')
        FROM event
        LEFT JOIN session_input AS input ON input.id = json_extract(event.data, '$.admission.messageID')
        LEFT JOIN session_message AS message
          ON message.id = json_extract(event.data, '$.admission.messageID')
          AND message.session_id = event.aggregate_id
          AND message.type = 'user'
        WHERE event.type = 'session.next.goal.updated.1'
          AND json_type(event.data, '$.admission.messageID') = 'text';
      `)
      yield* tx.run(`
        INSERT OR IGNORE INTO session_message_identity (
          id,
          session_id,
          owner,
          kind,
          input,
          state,
          time_created
        )
        SELECT
          json_extract(event.data, '$.messageID'),
          event.aggregate_id,
          'input',
          'prompt',
          json_object(
            'admitted',
            json_object(
              'admittedSeq', event.seq,
              'id', json_extract(event.data, '$.messageID'),
              'sessionID', event.aggregate_id,
              'prompt', json(json_extract(event.data, '$.prompt')),
              'delivery', json_extract(event.data, '$.delivery'),
              'timeCreated', json_extract(event.data, '$.timestamp'),
              'promotedSeq', event.seq
            )
          ),
          CASE WHEN input.id IS NULL AND message.id IS NULL THEN 'reverted' ELSE 'active' END,
          json_extract(event.data, '$.timestamp')
        FROM event
        LEFT JOIN session_input AS input ON input.id = json_extract(event.data, '$.messageID')
        LEFT JOIN session_message AS message
          ON message.id = json_extract(event.data, '$.messageID')
          AND message.session_id = event.aggregate_id
          AND message.type = 'user'
        WHERE event.type = 'session.next.prompted.1';
      `)
      yield* tx.run(`
        INSERT OR IGNORE INTO session_message_identity (
          id,
          session_id,
          owner,
          kind,
          state,
          creator_seq,
          time_created
        )
        SELECT
          message.id,
          message.session_id,
          'message',
          CASE WHEN message.type = 'shell' THEN 'shell' ELSE 'message' END,
          'active',
          message.seq,
          message.time_created
        FROM session_message AS message;
      `)
      yield* tx.run(`
        WITH message_event AS (
          SELECT
            CASE
              WHEN type = 'session.next.step.started.1' THEN json_extract(data, '$.assistantMessageID')
              ELSE json_extract(data, '$.messageID')
            END AS id,
            aggregate_id AS session_id,
            CASE WHEN type = 'session.next.shell.started.1' THEN 'shell' ELSE 'message' END AS kind,
            seq AS creator_seq,
            json_extract(data, '$.timestamp') AS time_created
          FROM event
          WHERE type IN (
            'session.next.agent.switched.1',
            'session.next.model.switched.1',
            'session.next.context.updated.1',
            'session.next.synthetic.1',
            'session.next.shell.started.1',
            'session.next.step.started.1',
            'session.next.compaction.ended.1'
          )
        )
        INSERT OR IGNORE INTO session_message_identity (
          id,
          session_id,
          owner,
          kind,
          state,
          creator_seq,
          time_created
        )
        SELECT
          message_event.id,
          message_event.session_id,
          'message',
          message_event.kind,
          CASE WHEN message.id IS NULL THEN 'reverted' ELSE 'active' END,
          message_event.creator_seq,
          message_event.time_created
        FROM message_event
        LEFT JOIN session_message AS message ON message.id = message_event.id
        WHERE message_event.id IS NOT NULL;
      `)
      const admissionProjectionConflict = yield* tx.get<{ id: string }>(`
        WITH claim(
          id,
          session_id,
          kind,
          seq,
          prompt,
          delivery,
          agent,
          model,
          command,
          time_created
        ) AS (
          SELECT
            json_extract(data, '$.messageID'),
            aggregate_id,
            CASE WHEN json_type(data, '$.command') IS NULL THEN 'prompt' ELSE 'command' END,
            seq,
            json_extract(data, '$.prompt'),
            json_extract(data, '$.delivery'),
            json_extract(data, '$.agent'),
            json_extract(data, '$.model'),
            json_extract(data, '$.command'),
            json_extract(data, '$.timestamp')
          FROM event
          WHERE type = 'session.next.prompt.admitted.1'
          UNION ALL
          SELECT
            json_extract(data, '$.admission.messageID'),
            aggregate_id,
            'goal',
            seq,
            json_extract(data, '$.admission.prompt'),
            json_extract(data, '$.admission.delivery'),
            json_extract(data, '$.admission.agent'),
            json_extract(data, '$.admission.model'),
            NULL,
            json_extract(data, '$.timestamp')
          FROM event
          WHERE type = 'session.next.goal.updated.1'
            AND json_type(data, '$.admission.messageID') = 'text'
        )
        SELECT claim.id
        FROM claim
        INNER JOIN session_message_identity AS identity ON identity.id = claim.id
        WHERE identity.owner <> 'input'
          OR identity.session_id <> claim.session_id
          OR identity.kind <> claim.kind
          OR identity.creator_seq IS NOT NULL
          OR identity.state <> CASE
            WHEN EXISTS (
              SELECT 1
              FROM session_input AS input
              WHERE input.id = claim.id AND input.session_id = claim.session_id
            ) OR EXISTS (
              SELECT 1
              FROM session_message AS message
              WHERE message.id = claim.id
                AND message.session_id = claim.session_id
                AND message.type = 'user'
            ) THEN 'active'
            ELSE 'reverted'
          END
          OR identity.time_created <> claim.time_created
          OR json_extract(identity.input, '$.admitted.admittedSeq') IS NOT claim.seq
          OR json_extract(identity.input, '$.admitted.id') IS NOT claim.id
          OR json_extract(identity.input, '$.admitted.sessionID') IS NOT claim.session_id
          OR json(json_extract(identity.input, '$.admitted.prompt')) IS NOT json(claim.prompt)
          OR json_extract(identity.input, '$.admitted.delivery') IS NOT claim.delivery
          OR json_extract(identity.input, '$.admitted.agent') IS NOT claim.agent
          OR json(json_extract(identity.input, '$.admitted.model')) IS NOT json(claim.model)
          OR json(json_extract(identity.input, '$.command')) IS NOT json(claim.command)
          OR json_extract(identity.input, '$.admitted.timeCreated') IS NOT claim.time_created
        LIMIT 1;
      `)
      if (admissionProjectionConflict)
        return yield* Effect.fail(
          new Error(`Durable Session admission projection requires repair: ${admissionProjectionConflict.id}`),
        )
      const promptedProjectionConflict = yield* tx.get<{ id: string }>(`
        WITH admission(id) AS (
          SELECT json_extract(data, '$.messageID')
          FROM event
          WHERE type = 'session.next.prompt.admitted.1'
          UNION ALL
          SELECT json_extract(data, '$.admission.messageID')
          FROM event
          WHERE type = 'session.next.goal.updated.1'
            AND json_type(data, '$.admission.messageID') = 'text'
        ),
        claim(id, session_id, seq, prompt, delivery, time_created) AS (
          SELECT
            json_extract(prompted.data, '$.messageID'),
            prompted.aggregate_id,
            prompted.seq,
            json_extract(prompted.data, '$.prompt'),
            json_extract(prompted.data, '$.delivery'),
            json_extract(prompted.data, '$.timestamp')
          FROM event AS prompted
          WHERE prompted.type = 'session.next.prompted.1'
            AND NOT EXISTS (
              SELECT 1
              FROM admission
              WHERE admission.id = json_extract(prompted.data, '$.messageID')
            )
        )
        SELECT claim.id
        FROM claim
        INNER JOIN session_message_identity AS identity ON identity.id = claim.id
        WHERE identity.owner <> 'input'
          OR identity.session_id <> claim.session_id
          OR identity.kind <> 'prompt'
          OR identity.creator_seq IS NOT NULL
          OR identity.state <> CASE
            WHEN EXISTS (
              SELECT 1
              FROM session_input AS input
              WHERE input.id = claim.id AND input.session_id = claim.session_id
            ) OR EXISTS (
              SELECT 1
              FROM session_message AS message
              WHERE message.id = claim.id
                AND message.session_id = claim.session_id
                AND message.type = 'user'
            ) THEN 'active'
            ELSE 'reverted'
          END
          OR identity.time_created <> claim.time_created
          OR json_extract(identity.input, '$.admitted.admittedSeq') IS NOT claim.seq
          OR json_extract(identity.input, '$.admitted.id') IS NOT claim.id
          OR json_extract(identity.input, '$.admitted.sessionID') IS NOT claim.session_id
          OR json(json_extract(identity.input, '$.admitted.prompt')) IS NOT json(claim.prompt)
          OR json_extract(identity.input, '$.admitted.delivery') IS NOT claim.delivery
          OR json_extract(identity.input, '$.admitted.agent') IS NOT NULL
          OR json_extract(identity.input, '$.admitted.model') IS NOT NULL
          OR json_extract(identity.input, '$.command') IS NOT NULL
          OR json_extract(identity.input, '$.admitted.timeCreated') IS NOT claim.time_created
        LIMIT 1;
      `)
      if (promptedProjectionConflict)
        return yield* Effect.fail(
          new Error(`Historical Session prompt projection requires repair: ${promptedProjectionConflict.id}`),
        )
      const messageProjectionConflict = yield* tx.get<{ id: string }>(`
        WITH claim(id, session_id, kind, creator_seq, time_created) AS (
          SELECT
            CASE
              WHEN type = 'session.next.step.started.1' THEN json_extract(data, '$.assistantMessageID')
              ELSE json_extract(data, '$.messageID')
            END,
            aggregate_id,
            CASE WHEN type = 'session.next.shell.started.1' THEN 'shell' ELSE 'message' END,
            seq,
            json_extract(data, '$.timestamp')
          FROM event
          WHERE type IN (
            'session.next.agent.switched.1',
            'session.next.model.switched.1',
            'session.next.context.updated.1',
            'session.next.synthetic.1',
            'session.next.shell.started.1',
            'session.next.step.started.1',
            'session.next.compaction.ended.1'
          )
        )
        SELECT claim.id
        FROM claim
        INNER JOIN session_message_identity AS identity ON identity.id = claim.id
        WHERE identity.owner <> 'message'
          OR identity.session_id <> claim.session_id
          OR identity.kind <> claim.kind
          OR identity.creator_seq IS NOT claim.creator_seq
          OR EXISTS (
            SELECT 1
            FROM session_message AS message
            WHERE message.id = claim.id
              AND message.session_id = claim.session_id
              AND (
                (claim.kind = 'shell' AND message.type <> 'shell')
                OR (claim.kind = 'message' AND message.type IN ('user', 'shell'))
              )
          )
          OR identity.state <> CASE
            WHEN EXISTS (
              SELECT 1
              FROM session_message AS message
              WHERE message.id = claim.id AND message.session_id = claim.session_id
            ) THEN 'active'
            ELSE 'reverted'
          END
          OR identity.time_created <> claim.time_created
        LIMIT 1;
      `)
      if (messageProjectionConflict)
        return yield* Effect.fail(
          new Error(`Durable Session message projection requires repair: ${messageProjectionConflict.id}`),
        )
    })
  },
} satisfies DatabaseMigration.Migration
