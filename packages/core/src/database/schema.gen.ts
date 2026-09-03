import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

export default {
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`agent_improvement_proposal\` (
          \`id\` text PRIMARY KEY,
          \`root_session_id\` text NOT NULL,
          \`agent\` text NOT NULL,
          \`author_session_id\` text NOT NULL,
          \`author_agent\` text NOT NULL,
          \`baseline_markdown\` text NOT NULL,
          \`proposal_markdown\` text NOT NULL,
          \`rationale\` text NOT NULL,
          \`evidence\` text NOT NULL,
          \`status\` text NOT NULL,
          \`validation\` text,
          \`error\` text,
          \`revision\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_agent_improvement_proposal_root_session_id_session_id_fk\` FOREIGN KEY (\`root_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`name\` text DEFAULT '' NOT NULL,
          \`branch\` text,
          \`directory\` text,
          \`extra\` text,
          \`project_id\` text NOT NULL,
          \`time_used\` integer NOT NULL,
          CONSTRAINT \`fk_workspace_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`data_migration\` (
          \`name\` text PRIMARY KEY,
          \`time_completed\` integer NOT NULL,
          \`source_fingerprint\` text,
          \`source_version\` text,
          \`row_count\` integer,
          \`time_verified\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_task_actor_claim\` (
          \`id\` text PRIMARY KEY,
          \`actor_session_id\` text NOT NULL,
          \`actor_assistant_message_id\` text NOT NULL,
          \`actor_tool_call_id\` text NOT NULL,
          \`operation_id\` text NOT NULL UNIQUE,
          \`task_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`request_hash\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_task_operation\` (
          \`id\` text PRIMARY KEY,
          \`task_id\` text NOT NULL,
          \`root_session_id\` text NOT NULL,
          \`actor_session_id\` text NOT NULL,
          \`actor_assistant_message_id\` text NOT NULL,
          \`actor_tool_call_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`request_hash\` text NOT NULL,
          \`message_id\` text,
          \`prompt\` text,
          \`status\` text NOT NULL,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_session_task_operation_task_id_session_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`session_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_task_operation_root_session_id_session_id_fk\` FOREIGN KEY (\`root_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_task_operation_actor_session_id_session_id_fk\` FOREIGN KEY (\`actor_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_task\` (
          \`id\` text PRIMARY KEY,
          \`root_session_id\` text NOT NULL,
          \`parent_session_id\` text NOT NULL,
          \`child_session_id\` text NOT NULL UNIQUE,
          \`parent_task_id\` text,
          \`actor_session_id\` text NOT NULL,
          \`actor_assistant_message_id\` text NOT NULL,
          \`actor_tool_call_id\` text NOT NULL,
          \`agent\` text NOT NULL,
          \`model\` text,
          \`prompt\` text NOT NULL,
          \`description\` text NOT NULL,
          \`depth\` integer NOT NULL,
          \`status\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`parent_permissions\` text NOT NULL,
          \`ancestor_permission_sets\` text NOT NULL,
          \`child_permissions\` text NOT NULL,
          \`hard_permissions\` text NOT NULL,
          \`write_roots\` text NOT NULL,
          \`commands\` text NOT NULL,
          \`result\` text,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_started\` integer,
          \`time_completed\` integer,
          CONSTRAINT \`fk_session_task_root_session_id_session_id_fk\` FOREIGN KEY (\`root_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_task_parent_session_id_session_id_fk\` FOREIGN KEY (\`parent_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_task_parent_task_id_session_task_id_fk\` FOREIGN KEY (\`parent_task_id\`) REFERENCES \`session_task\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`team_board_note\` (
          \`id\` text PRIMARY KEY,
          \`root_session_id\` text NOT NULL,
          \`author_session_id\` text NOT NULL,
          \`author_agent\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`title\` text NOT NULL,
          \`body\` text NOT NULL,
          \`evidence\` text,
          \`supersedes\` text,
          \`superseded_by\` text,
          \`revision\` integer NOT NULL,
          \`parent_notification_status\` text DEFAULT 'none' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_team_board_note_root_session_id_session_id_fk\` FOREIGN KEY (\`root_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`tool_execution\` (
          \`session_id\` text NOT NULL,
          \`assistant_message_id\` text NOT NULL,
          \`call_id\` text NOT NULL,
          \`request_hash\` text NOT NULL,
          \`retryable_error\` integer DEFAULT false NOT NULL,
          \`status\` text NOT NULL,
          \`owner_id\` text,
          \`settlement\` text,
          \`lease_expires_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`tool_execution_pk\` PRIMARY KEY(\`session_id\`, \`assistant_message_id\`, \`call_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account_state\` (
          \`id\` integer PRIMARY KEY,
          \`active_account_id\` text,
          \`active_org_id\` text,
          CONSTRAINT \`fk_account_state_active_account_id_account_id_fk\` FOREIGN KEY (\`active_account_id\`) REFERENCES \`account\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account\` (
          \`id\` text PRIMARY KEY,
          \`remote_id\` text DEFAULT '' NOT NULL,
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`control_account\` (
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`active\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`control_account_pk\` PRIMARY KEY(\`email\`, \`url\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`credential\` (
          \`id\` text PRIMARY KEY,
          \`integration_id\` text,
          \`label\` text NOT NULL,
          \`value\` text NOT NULL,
          \`connector_id\` text,
          \`method_id\` text,
          \`active\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_sequence\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`owner_id\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event\` (
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`loop_run\` (
          \`id\` text PRIMARY KEY,
          \`loop_id\` text NOT NULL,
          \`scheduled_at\` integer NOT NULL,
          \`trigger\` text NOT NULL,
          \`status\` text NOT NULL,
          \`current_step\` integer DEFAULT 0 NOT NULL,
          \`step_outputs\` text DEFAULT '{}' NOT NULL,
          \`lease_owner\` text,
          \`lease_expires_at\` integer,
          \`session_id\` text,
          \`execution_title\` text,
          \`execution_prompt\` text,
          \`execution_directory\` text,
          \`execution_workspace_id\` text,
          \`execution_agent\` text,
          \`execution_model\` text,
          \`execution_skill\` text,
          \`execution_workflow\` text,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_started\` integer,
          \`time_completed\` integer,
          CONSTRAINT \`fk_loop_run_loop_id_loop_id_fk\` FOREIGN KEY (\`loop_id\`) REFERENCES \`loop\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`loop\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`workspace_id\` text,
          \`agent\` text,
          \`model\` text,
          \`skill\` text,
          \`workflow\` text,
          \`status\` text NOT NULL,
          \`schedule_type\` text NOT NULL,
          \`interval_seconds\` integer NOT NULL,
          \`timezone\` text NOT NULL,
          \`overlap_policy\` text NOT NULL,
          \`starts_at\` integer NOT NULL,
          \`next_run_at\` integer,
          \`expires_at\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_drawer\` (
          \`id\` text PRIMARY KEY,
          \`wing_id\` text NOT NULL,
          \`room_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`title\` text NOT NULL,
          \`body\` text NOT NULL,
          \`anchor_repo\` text,
          \`anchor_path\` text,
          \`anchor_commit\` text,
          \`anchor_symbol\` text,
          \`asserted_by\` text NOT NULL,
          \`source\` text NOT NULL,
          \`session_id\` text,
          \`time_valid_from\` integer NOT NULL,
          \`time_valid_until\` integer,
          \`superseded_by\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_memory_drawer_wing_id_memory_wing_id_fk\` FOREIGN KEY (\`wing_id\`) REFERENCES \`memory_wing\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_memory_drawer_room_id_memory_room_id_fk\` FOREIGN KEY (\`room_id\`) REFERENCES \`memory_room\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_memory_drawer_superseded_by_memory_drawer_id_fk\` FOREIGN KEY (\`superseded_by\`) REFERENCES \`memory_drawer\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_room\` (
          \`id\` text PRIMARY KEY,
          \`wing_id\` text NOT NULL,
          \`slug\` text NOT NULL,
          \`name\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_memory_room_wing_id_memory_wing_id_fk\` FOREIGN KEY (\`wing_id\`) REFERENCES \`memory_wing\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_wing\` (
          \`id\` text PRIMARY KEY,
          \`kind\` text NOT NULL,
          \`key\` text NOT NULL,
          \`name\` text NOT NULL,
          \`project_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_memory_wing_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`pentest_evidence\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`execution_id\` text,
          \`finding_id\` text NOT NULL,
          \`locator_kind\` text NOT NULL,
          \`reference\` text,
          \`excerpt\` text NOT NULL,
          \`author\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_pentest_evidence_run_id_pentest_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`pentest_run\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_pentest_evidence_finding_id_pentest_finding_id_fk\` FOREIGN KEY (\`finding_id\`) REFERENCES \`pentest_finding\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`pentest_execution\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`idempotency_key\` text NOT NULL,
          \`request_hash\` text NOT NULL,
          \`result_run_revision\` integer NOT NULL,
          \`attempt\` integer NOT NULL,
          \`model_json\` text NOT NULL,
          \`profile_id\` text NOT NULL,
          \`profile_revision\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`stage\` text NOT NULL,
          \`cancel_requested\` integer NOT NULL,
          \`cancel_idempotency_key\` text,
          \`cancel_request_hash\` text,
          \`cancel_result_run_revision\` integer,
          \`fence\` integer NOT NULL,
          \`lease_owner\` text,
          \`lease_until\` integer,
          \`last_heartbeat\` integer,
          \`checkpoint_json\` text,
          \`location_json\` text,
          \`absolute_ttl\` integer NOT NULL,
          \`revision\` integer NOT NULL,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_pentest_execution_run_id_pentest_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`pentest_run\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`pentest_finding\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`severity\` text NOT NULL,
          \`confidence\` real,
          \`title\` text NOT NULL,
          \`type\` text NOT NULL,
          \`endpoint\` text NOT NULL,
          \`cvss_vector\` text,
          \`cvss_score\` real NOT NULL,
          \`owasp\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`remediation\` text NOT NULL,
          \`reproduction\` text,
          \`status\` text NOT NULL,
          \`author\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_pentest_finding_run_id_pentest_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`pentest_run\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`pentest_http_session\` (
          \`run_id\` text NOT NULL,
          \`profile_id\` text NOT NULL,
          \`sealed_state\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`pentest_http_session_pk\` PRIMARY KEY(\`run_id\`, \`profile_id\`),
          CONSTRAINT \`fk_pentest_http_session_run_id_pentest_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`pentest_run\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "pentest_http_session_revision_positive" CHECK("revision" > 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`pentest_model_usage\` (
          \`run_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`assistant_message_id\` text NOT NULL,
          \`model_tokens\` integer DEFAULT 0 NOT NULL,
          \`model_cost_usd\` real DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`pentest_model_usage_pk\` PRIMARY KEY(\`run_id\`, \`session_id\`, \`assistant_message_id\`),
          CONSTRAINT \`fk_pentest_model_usage_run_id_pentest_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`pentest_run\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`pentest_report\` (
          \`run_id\` text PRIMARY KEY,
          \`execution_id\` text,
          \`execution_fence\` integer,
          \`markdown\` text NOT NULL,
          \`content_sha256\` text,
          \`evidence_sha256\` text,
          \`generated_at\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_pentest_report_run_id_pentest_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`pentest_run\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_pentest_report_execution_id_pentest_execution_id_fk\` FOREIGN KEY (\`execution_id\`) REFERENCES \`pentest_execution\`(\`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`pentest_run\` (
          \`id\` text PRIMARY KEY,
          \`idempotency_key\` text NOT NULL,
          \`request_hash\` text NOT NULL,
          \`project_id\` text,
          \`location_json\` text,
          \`session_id\` text,
          \`status\` text NOT NULL,
          \`current_stage\` text NOT NULL,
          \`labels_json\` text NOT NULL,
          \`goal_json\` text NOT NULL,
          \`model_tokens_used\` integer DEFAULT 0 NOT NULL,
          \`model_cost_usd_used\` real DEFAULT 0 NOT NULL,
          \`request_count\` integer DEFAULT 0 NOT NULL,
          \`revision\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_directory\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`type\` text,
          \`strategy\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`project_directory_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_project_directory_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`part\` (
          \`id\` text PRIMARY KEY,
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
        );
      `)
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
      yield* tx.run(`
        CREATE TABLE \`session_context_epoch\` (
          \`session_id\` text PRIMARY KEY,
          \`baseline\` text NOT NULL,
          \`snapshot\` text NOT NULL,
          \`baseline_seq\` integer NOT NULL,
          CONSTRAINT \`fk_session_context_epoch_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_goal_identity\` (
          \`goal_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`message_id\` text UNIQUE,
          \`objective\` text NOT NULL,
          \`state\` text NOT NULL,
          \`final_revision\` integer,
          \`time_created\` integer NOT NULL,
          \`time_terminal\` integer,
          CONSTRAINT \`fk_session_goal_identity_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_goal\` (
          \`session_id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL UNIQUE,
          \`revision\` integer NOT NULL,
          \`objective\` text NOT NULL,
          \`status\` text NOT NULL,
          \`tokens_used\` integer NOT NULL,
          \`active_time_ms\` integer NOT NULL,
          \`status_changed_at\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_session_goal_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_goal_turn\` (
          \`assistant_message_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`goal_id\` text NOT NULL,
          \`goal_revision\` integer NOT NULL,
          \`token_delta\` integer NOT NULL,
          \`active_time_ms_delta\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_goal_turn_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_harness\` (
          \`session_id\` text PRIMARY KEY,
          \`revision\` integer NOT NULL,
          \`version\` integer NOT NULL,
          \`snapshot\` text NOT NULL,
          \`snapshots\` text NOT NULL,
          \`proposals\` text NOT NULL,
          \`reviewer_requests\` text DEFAULT '[]' NOT NULL,
          \`reviewer_runs\` text DEFAULT '[]' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_harness_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_input\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`source\` text DEFAULT 'user' NOT NULL,
          \`agent\` text,
          \`model\` text,
          \`command\` text,
          \`admitted_seq\` integer NOT NULL,
          \`promoted_seq\` integer,
          \`time_cancelled\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_input_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
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
      yield* tx.run(`
        CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          \`status\` text DEFAULT 'idle' NOT NULL,
          \`status_owner\` text,
          \`status_attempt\` integer,
          \`status_message\` text,
          \`status_next\` integer,
          \`status_action\` text,
          CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_transcript_adoption\` (
          \`session_id\` text PRIMARY KEY,
          \`state\` text NOT NULL,
          \`version\` integer NOT NULL,
          \`time_started\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_session_transcript_adoption_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`todo\` (
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`todo_pk\` PRIMARY KEY(\`session_id\`, \`position\`),
          CONSTRAINT \`fk_todo_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_share\` (
          \`session_id\` text PRIMARY KEY,
          \`id\` text NOT NULL,
          \`secret\` text NOT NULL,
          \`url\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_share_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`storage_state\` (
          \`scope\` text NOT NULL,
          \`key\` text NOT NULL,
          \`value\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`deleted\` integer DEFAULT false NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`storage_state_pk\` PRIMARY KEY(\`scope\`, \`key\`)
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`agent_improvement_root_idx\` ON \`agent_improvement_proposal\` (\`root_session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_task_actor_claim_actor_idx\` ON \`session_task_actor_claim\` (\`actor_session_id\`,\`actor_assistant_message_id\`,\`actor_tool_call_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_task_actor_claim_task_idx\` ON \`session_task_actor_claim\` (\`task_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_task_operation_actor_idx\` ON \`session_task_operation\` (\`actor_session_id\`,\`actor_assistant_message_id\`,\`actor_tool_call_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_task_operation_task_idx\` ON \`session_task_operation\` (\`task_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_task_operation_status_created_idx\` ON \`session_task_operation\` (\`status\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_task_operation_message_idx\` ON \`session_task_operation\` (\`message_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_task_operation_applied_message_task_idx\` ON \`session_task_operation\` (\`message_id\`,\`task_id\`) WHERE "session_task_operation"."status" = 'applied' AND "session_task_operation"."message_id" IS NOT NULL;`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_task_root_status_idx\` ON \`session_task\` (\`root_session_id\`,\`status\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_task_root_created_idx\` ON \`session_task\` (\`root_session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_task_parent_created_idx\` ON \`session_task\` (\`parent_session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_task_parent_task_idx\` ON \`session_task\` (\`parent_task_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_task_status_created_idx\` ON \`session_task\` (\`status\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`team_board_root_idx\` ON \`team_board_note\` (\`root_session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`team_board_pending_notification_idx\` ON \`team_board_note\` (\`parent_notification_status\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`account_url_remote_idx\` ON \`account\` (\`url\`,\`remote_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_type_idx\` ON \`event\` (\`type\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`loop_run_occurrence_idx\` ON \`loop_run\` (\`loop_id\`,\`scheduled_at\`);`)
      yield* tx.run(`CREATE INDEX \`loop_run_status_lease_idx\` ON \`loop_run\` (\`status\`,\`lease_expires_at\`);`)
      yield* tx.run(`CREATE INDEX \`loop_run_loop_created_idx\` ON \`loop_run\` (\`loop_id\`,\`time_created\`,\`id\`);`)
      yield* tx.run(`CREATE INDEX \`loop_status_due_idx\` ON \`loop\` (\`status\`,\`next_run_at\`);`)
      yield* tx.run(`CREATE INDEX \`loop_created_idx\` ON \`loop\` (\`time_created\`,\`id\`);`)
      yield* tx.run(
        `CREATE INDEX \`memory_drawer_wing_valid_idx\` ON \`memory_drawer\` (\`wing_id\`,\`time_valid_until\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_drawer_room_idx\` ON \`memory_drawer\` (\`room_id\`,\`time_created\`);`)
      yield* tx.run(
        `CREATE INDEX \`memory_drawer_anchor_idx\` ON \`memory_drawer\` (\`wing_id\`,\`anchor_repo\`,\`anchor_path\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_drawer_session_idx\` ON \`memory_drawer\` (\`session_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`memory_room_wing_slug_idx\` ON \`memory_room\` (\`wing_id\`,\`slug\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`memory_wing_kind_key_idx\` ON \`memory_wing\` (\`kind\`,\`key\`);`)
      yield* tx.run(`CREATE INDEX \`pentest_evidence_run_idx\` ON \`pentest_evidence\` (\`run_id\`,\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`pentest_evidence_finding_idx\` ON \`pentest_evidence\` (\`finding_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`pentest_execution_run_attempt_idx\` ON \`pentest_execution\` (\`run_id\`,\`attempt\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`pentest_execution_idempotency_idx\` ON \`pentest_execution\` (\`run_id\`,\`idempotency_key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`pentest_execution_run_idx\` ON \`pentest_execution\` (\`run_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`pentest_execution_claim_idx\` ON \`pentest_execution\` (\`state\`,\`lease_until\`,\`absolute_ttl\`);`,
      )
      yield* tx.run(`CREATE INDEX \`pentest_finding_run_idx\` ON \`pentest_finding\` (\`run_id\`,\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`pentest_finding_severity_idx\` ON \`pentest_finding\` (\`run_id\`,\`severity\`);`)
      yield* tx.run(
        `CREATE INDEX \`pentest_http_session_run_idx\` ON \`pentest_http_session\` (\`run_id\`,\`time_updated\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`pentest_model_usage_session_idx\` ON \`pentest_model_usage\` (\`session_id\`,\`assistant_message_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`pentest_report_run_idx\` ON \`pentest_report\` (\`run_id\`,\`time_created\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`pentest_run_idempotency_idx\` ON \`pentest_run\` (\`idempotency_key\`);`)
      yield* tx.run(
        `CREATE INDEX \`pentest_run_owner_list_idx\` ON \`pentest_run\` (\`project_id\`,\`location_json\`,\`time_updated\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`pentest_run_location_list_idx\` ON \`pentest_run\` (\`location_json\`,\`time_updated\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`pentest_run_list_idx\` ON \`pentest_run\` (\`time_updated\`,\`id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_project_action_resource_idx\` ON \`permission\` (\`project_id\`,\`action\`,\`resource\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);`)
      yield* tx.run(`CREATE INDEX \`part_session_idx\` ON \`part\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`provider_usage_time_idx\` ON \`provider_usage\` (\`time\`);`)
      yield* tx.run(`CREATE INDEX \`session_goal_identity_session_idx\` ON \`session_goal_identity\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_goal_status_idx\` ON \`session_goal\` (\`status\`);`)
      yield* tx.run(`CREATE INDEX \`session_goal_turn_session_idx\` ON \`session_goal_turn\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_input_session_pending_delivery_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`,\`delivery\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_input_session_pending_source_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`,\`source\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_admitted_seq_idx\` ON \`session_input\` (\`session_id\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_promoted_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_input_pending_id_idx\` ON \`session_input\` (\`id\`) WHERE "session_input"."promoted_seq" IS NULL AND "session_input"."time_cancelled" IS NULL;`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_input_pending_board_session_idx\` ON \`session_input\` (\`session_id\`) WHERE "session_input"."source" = 'subagent_board' AND "session_input"."promoted_seq" IS NULL AND "session_input"."time_cancelled" IS NULL;`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_identity_session_idx\` ON \`session_message_identity\` (\`session_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`session_project_idx\` ON \`session\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_time_created_id_idx\` ON \`session\` (\`time_created\`,\`id\`);`)
      yield* tx.run(`CREATE INDEX \`session_time_updated_id_idx\` ON \`session\` (\`time_updated\`,\`id\`);`)
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
