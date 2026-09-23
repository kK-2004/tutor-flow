CREATE TABLE `content_job` (
	`id` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`direction_mode` text NOT NULL,
	`publish_mode` text NOT NULL,
	`platform` text NOT NULL,
	`account_id` text NOT NULL,
	`trigger_type` text NOT NULL,
	`triggered_by` text NOT NULL,
	`scheduler_key` text,
	`expected_run_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `content_job_account_idx` ON `content_job` (`account_id`);--> statement-breakpoint
CREATE INDEX `content_job_created_idx` ON `content_job` (`created_at`);--> statement-breakpoint
CREATE TABLE `outbox_record` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_name` text NOT NULL,
	`aggregate_type` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`payload` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`dispatched_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `outbox_record` (`dispatched_at`,`id`);--> statement-breakpoint
CREATE INDEX `outbox_aggregate_idx` ON `outbox_record` (`aggregate_type`,`aggregate_id`);--> statement-breakpoint
CREATE TABLE `step_run` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_type` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`input_hash` text,
	`output_ref` text,
	`error_category` text,
	`error_message` text,
	`trace_id` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `step_run_attempt_unique` ON `step_run` (`run_id`,`step_type`,`attempt_no`);--> statement-breakpoint
CREATE INDEX `step_run_run_idx` ON `step_run` (`run_id`);--> statement-breakpoint
CREATE TABLE `trigger_idempotency` (
	`id` text PRIMARY KEY NOT NULL,
	`caller_identity` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`content_job_id` text NOT NULL,
	`workflow_run_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`content_job_id`) REFERENCES `content_job`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trigger_idempotency_caller_key_unique` ON `trigger_idempotency` (`caller_identity`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `workflow_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`name` text NOT NULL,
	`payload` text NOT NULL,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_event_run_seq_unique` ON `workflow_event` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `workflow_run` (
	`id` text PRIMARY KEY NOT NULL,
	`content_job_id` text NOT NULL,
	`status` text DEFAULT 'QUEUED' NOT NULL,
	`current_step_type` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`human_wait_since` integer,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`cancel_requested_at` integer,
	`cancel_requested_by` text,
	`version` integer DEFAULT 1 NOT NULL,
	`trace_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`content_job_id`) REFERENCES `content_job`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflow_run_status_idx` ON `workflow_run` (`status`);--> statement-breakpoint
CREATE INDEX `workflow_run_job_idx` ON `workflow_run` (`content_job_id`);--> statement-breakpoint
CREATE TABLE `claim_source` (
	`claim_id` text NOT NULL,
	`source_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`claim_id`, `source_id`),
	FOREIGN KEY (`claim_id`) REFERENCES `claim`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `source_document`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `claim` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`statement` text NOT NULL,
	`confidence` real NOT NULL,
	`primary_source_supported` integer DEFAULT false NOT NULL,
	`verified_at` integer,
	`used_in` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `claim_run_idx` ON `claim` (`run_id`);--> statement-breakpoint
CREATE TABLE `content_artifact` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`version` integer NOT NULL,
	`title` text,
	`body` text NOT NULL,
	`tags` text NOT NULL,
	`media_object_keys` text NOT NULL,
	`claim_usages` text NOT NULL,
	`generation` text,
	`ai_generated` integer DEFAULT true NOT NULL,
	`aigc_disclosure` text DEFAULT 'undisclosed' NOT NULL,
	`human_review` text DEFAULT 'not_reviewed' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_artifact_run_kind_version_unique` ON `content_artifact` (`run_id`,`kind`,`version`);--> statement-breakpoint
CREATE TABLE `direction_claim` (
	`direction_id` text NOT NULL,
	`claim_id` text NOT NULL,
	PRIMARY KEY(`direction_id`, `claim_id`),
	FOREIGN KEY (`direction_id`) REFERENCES `direction_option`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claim_id`) REFERENCES `claim`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `direction_option` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`target_audience` text NOT NULL,
	`keywords` text NOT NULL,
	`score_factors` text NOT NULL,
	`total_score` real NOT NULL,
	`rank` integer NOT NULL,
	`scoring_inputs` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `direction_option_run_rank_idx` ON `direction_option` (`run_id`,`rank`);--> statement-breakpoint
CREATE TABLE `duplicate_cluster` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`canonical_source_id` text,
	`method` text NOT NULL,
	`similarity` real,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `duplicate_cluster_run_idx` ON `duplicate_cluster` (`run_id`);--> statement-breakpoint
CREATE TABLE `query_plan` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`queries` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`usage` text NOT NULL,
	`partial_failures` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `query_plan_run_idx` ON `query_plan` (`run_id`);--> statement-breakpoint
CREATE TABLE `source_document` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`canonical_url` text NOT NULL,
	`url_hash` text NOT NULL,
	`title` text NOT NULL,
	`domain` text NOT NULL,
	`language` text NOT NULL,
	`source_type` text DEFAULT 'OTHER' NOT NULL,
	`fetch_status` text DEFAULT 'PENDING' NOT NULL,
	`fetch_note` text,
	`content_hash` text,
	`published_at` text,
	`fetched_at` integer,
	`is_primary` integer DEFAULT false NOT NULL,
	`cluster_id` text,
	`cluster_role` text,
	`score_factors` text,
	`total_score` real,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cluster_id`) REFERENCES `duplicate_cluster`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_document_run_url_unique` ON `source_document` (`run_id`,`url_hash`);--> statement-breakpoint
CREATE INDEX `source_document_cluster_idx` ON `source_document` (`cluster_id`);--> statement-breakpoint
CREATE INDEX `source_document_run_idx` ON `source_document` (`run_id`);--> statement-breakpoint
CREATE TABLE `draft_revision` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`revision` integer NOT NULL,
	`status` text DEFAULT 'PENDING_REVIEW' NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`tags` text NOT NULL,
	`media_object_keys` text NOT NULL,
	`source_artifact_id` text,
	`claim_usages` text NOT NULL,
	`aigc_disclosure` text DEFAULT 'disclosed' NOT NULL,
	`approved_by` text,
	`approved_at` integer,
	`approved_policy_version` text,
	`sanitization_notes` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_artifact_id`) REFERENCES `content_artifact`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draft_revision_run_revision_unique` ON `draft_revision` (`run_id`,`revision`);--> statement-breakpoint
CREATE INDEX `draft_revision_status_idx` ON `draft_revision` (`status`);--> statement-breakpoint
CREATE TABLE `platform_account` (
	`id` text PRIMARY KEY NOT NULL,
	`alias` text NOT NULL,
	`platform` text DEFAULT 'xiaohongshu' NOT NULL,
	`auth_type` text DEFAULT 'cookie_session' NOT NULL,
	`secret_ref` text NOT NULL,
	`health` text DEFAULT 'UNKNOWN' NOT NULL,
	`last_auth_check_at` integer,
	`last_auth_check_note` text,
	`auto_publish_allowed` integer DEFAULT false NOT NULL,
	`concurrency` integer DEFAULT 1 NOT NULL,
	`tokens_per_window` integer DEFAULT 4 NOT NULL,
	`window_ms` integer DEFAULT 3600000 NOT NULL,
	`needs_human_attention` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_account_alias_unique` ON `platform_account` (`alias`);--> statement-breakpoint
CREATE TABLE `platform_policy` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text DEFAULT 'xiaohongshu' NOT NULL,
	`version` text NOT NULL,
	`policy` text NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_policy_platform_version_unique` ON `platform_policy` (`platform`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `platform_policy_active_unique` ON `platform_policy` (`platform`) WHERE is_active;--> statement-breakpoint
CREATE TABLE `publish_job` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`draft_revision_id` text NOT NULL,
	`account_id` text NOT NULL,
	`status` text DEFAULT 'QUEUED' NOT NULL,
	`idempotency_key` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`approved_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`draft_revision_id`) REFERENCES `draft_revision`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `platform_account`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publish_job_draft_revision_unique` ON `publish_job` (`draft_revision_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `publish_job_idempotency_key_unique` ON `publish_job` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `publish_job_status_idx` ON `publish_job` (`status`);--> statement-breakpoint
CREATE TABLE `publish_receipt` (
	`id` text PRIMARY KEY NOT NULL,
	`publish_job_id` text NOT NULL,
	`platform_post_id` text NOT NULL,
	`platform_url` text,
	`request_hash` text NOT NULL,
	`sanitized_response` text NOT NULL,
	`published_at` integer NOT NULL,
	`policy_version` text NOT NULL,
	`verification` text DEFAULT 'PENDING' NOT NULL,
	`verification_note` text,
	`verified_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`publish_job_id`) REFERENCES `publish_job`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publish_receipt_job_unique` ON `publish_receipt` (`publish_job_id`);--> statement-breakpoint
CREATE TABLE `audit_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`occurred_at` integer NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`run_id` text,
	`publish_job_id` text,
	`payload` text,
	`trace_id` text
);
--> statement-breakpoint
CREATE INDEX `audit_event_occurred_idx` ON `audit_event` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `audit_event_resource_idx` ON `audit_event` (`resource_type`,`resource_id`);--> statement-breakpoint
CREATE INDEX `audit_event_run_idx` ON `audit_event` (`run_id`);--> statement-breakpoint
CREATE TABLE `system_setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
-- 审计事件表只追加：用触发器阻止更新与删除（不可变审计）
CREATE TRIGGER audit_event_immutable_update
  BEFORE UPDATE ON "audit_event"
BEGIN
  SELECT RAISE(ABORT, 'audit_event 为只追加表，禁止更新或删除');
END;
--> statement-breakpoint
CREATE TRIGGER audit_event_immutable_delete
  BEFORE DELETE ON "audit_event"
BEGIN
  SELECT RAISE(ABORT, 'audit_event 为只追加表，禁止更新或删除');
END;
