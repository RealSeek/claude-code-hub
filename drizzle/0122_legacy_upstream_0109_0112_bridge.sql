-- 兼容曾执行旧本地 0109-0119 的数据库：这些数据库会因 created_at 较新而跳过
-- 上游 0109-0112。所有语句均按最终 schema 幂等补齐，不回退后续迁移已演进的账本触发器。
CREATE TABLE IF NOT EXISTS "provider_batch_apply_operations" (
  "claim_key" varchar(256) PRIMARY KEY NOT NULL,
  "preview_token" varchar(256) NOT NULL,
  "payload_fingerprint" varchar(128) NOT NULL,
  "operation_id" varchar(256) NOT NULL,
  "undo_token" varchar(256) NOT NULL,
  "undo_expires_at" timestamp with time zone,
  "undo_consumed_at" timestamp with time zone,
  "status" varchar(32) NOT NULL,
  "result" jsonb,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
DECLARE
  incompatible_column text;
BEGIN
  SELECT expected.table_name || '.' || expected.column_name
  INTO incompatible_column
  FROM (VALUES
    ('provider_batch_apply_operations', 'claim_key', 'character varying(256)', true),
    ('provider_batch_apply_operations', 'preview_token', 'character varying(256)', true),
    ('provider_batch_apply_operations', 'payload_fingerprint', 'character varying(128)', true),
    ('provider_batch_apply_operations', 'operation_id', 'character varying(256)', true),
    ('provider_batch_apply_operations', 'undo_token', 'character varying(256)', true),
    ('provider_batch_apply_operations', 'undo_expires_at', 'timestamp with time zone', false),
    ('provider_batch_apply_operations', 'undo_consumed_at', 'timestamp with time zone', false),
    ('provider_batch_apply_operations', 'status', 'character varying(32)', true),
    ('provider_batch_apply_operations', 'result', 'jsonb', false),
    ('provider_batch_apply_operations', 'expires_at', 'timestamp with time zone', true),
    ('provider_batch_apply_operations', 'created_at', 'timestamp with time zone', true),
    ('provider_batch_apply_operations', 'updated_at', 'timestamp with time zone', true)
  ) AS expected(table_name, column_name, data_type, required_not_null)
  LEFT JOIN pg_class relation ON relation.relname = expected.table_name
    AND relation.relnamespace = 'public'::regnamespace
  LEFT JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
    AND attribute.attname = expected.column_name
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
  WHERE attribute.attname IS NULL
    OR format_type(attribute.atttypid, attribute.atttypmod) <> expected.data_type
    OR (expected.required_not_null AND NOT attribute.attnotnull)
  LIMIT 1;

  IF incompatible_column IS NOT NULL THEN
    RAISE EXCEPTION '% 结构与最终 schema 不兼容，拒绝自动桥接', incompatible_column;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_provider_batch_apply_operations_preview_token" ON "provider_batch_apply_operations" ("preview_token");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_provider_batch_apply_operations_operation_id" ON "provider_batch_apply_operations" ("operation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_provider_batch_apply_operations_undo_token" ON "provider_batch_apply_operations" ("undo_token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_batch_apply_operations_expires_at" ON "provider_batch_apply_operations" ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_cache_effectiveness" (
  "id" serial PRIMARY KEY NOT NULL,
  "provider_id" integer NOT NULL,
  "model" varchar(128) NOT NULL,
  "cache_ttl_bucket" varchar(10) NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "window_end" timestamp with time zone NOT NULL,
  "sample_count" integer DEFAULT 0 NOT NULL,
  "eligible_count" integer DEFAULT 0 NOT NULL,
  "theoretical_cache_tokens" bigint DEFAULT 0 NOT NULL,
  "observed_cache_read_tokens" bigint DEFAULT 0 NOT NULL,
  "raw_effectiveness_bp" integer DEFAULT 0 NOT NULL,
  "confidence_bp" integer DEFAULT 0 NOT NULL,
  "effectiveness_bp" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "replay_payloads" (
  "replay_id" varchar(64) PRIMARY KEY NOT NULL,
  "verifier" varchar(64) NOT NULL,
  "scope_tag" varchar(16) NOT NULL,
  "key_id" integer NOT NULL,
  "user_id" integer NOT NULL,
  "format" varchar(16) NOT NULL,
  "model" varchar(128),
  "status_code" integer NOT NULL,
  "headers_json" jsonb,
  "payload" text NOT NULL,
  "byte_size" integer NOT NULL,
  "source_message_request_id" integer,
  "created_at" timestamp with time zone DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$
DECLARE
  incompatible_column text;
BEGIN
  SELECT expected.table_name || '.' || expected.column_name
  INTO incompatible_column
  FROM (VALUES
    ('provider_cache_effectiveness', 'id', 'integer', true),
    ('provider_cache_effectiveness', 'provider_id', 'integer', true),
    ('provider_cache_effectiveness', 'model', 'character varying(128)', true),
    ('provider_cache_effectiveness', 'cache_ttl_bucket', 'character varying(10)', true),
    ('provider_cache_effectiveness', 'window_start', 'timestamp with time zone', true),
    ('provider_cache_effectiveness', 'window_end', 'timestamp with time zone', true),
    ('provider_cache_effectiveness', 'sample_count', 'integer', true),
    ('provider_cache_effectiveness', 'eligible_count', 'integer', true),
    ('provider_cache_effectiveness', 'theoretical_cache_tokens', 'bigint', true),
    ('provider_cache_effectiveness', 'observed_cache_read_tokens', 'bigint', true),
    ('provider_cache_effectiveness', 'raw_effectiveness_bp', 'integer', true),
    ('provider_cache_effectiveness', 'confidence_bp', 'integer', true),
    ('provider_cache_effectiveness', 'effectiveness_bp', 'integer', true),
    ('provider_cache_effectiveness', 'created_at', 'timestamp with time zone', false),
    ('replay_payloads', 'replay_id', 'character varying(64)', true),
    ('replay_payloads', 'verifier', 'character varying(64)', true),
    ('replay_payloads', 'scope_tag', 'character varying(16)', true),
    ('replay_payloads', 'key_id', 'integer', true),
    ('replay_payloads', 'user_id', 'integer', true),
    ('replay_payloads', 'format', 'character varying(16)', true),
    ('replay_payloads', 'model', 'character varying(128)', false),
    ('replay_payloads', 'status_code', 'integer', true),
    ('replay_payloads', 'headers_json', 'jsonb', false),
    ('replay_payloads', 'payload', 'text', true),
    ('replay_payloads', 'byte_size', 'integer', true),
    ('replay_payloads', 'source_message_request_id', 'integer', false),
    ('replay_payloads', 'created_at', 'timestamp with time zone', false),
    ('replay_payloads', 'expires_at', 'timestamp with time zone', true)
  ) AS expected(table_name, column_name, data_type, required_not_null)
  LEFT JOIN pg_class relation ON relation.relname = expected.table_name
    AND relation.relnamespace = 'public'::regnamespace
  LEFT JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
    AND attribute.attname = expected.column_name
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
  WHERE attribute.attname IS NULL
    OR format_type(attribute.atttypid, attribute.atttypmod) <> expected.data_type
    OR (expected.required_not_null AND NOT attribute.attnotnull)
  LIMIT 1;

  IF incompatible_column IS NOT NULL THEN
    RAISE EXCEPTION '% 结构与最终 schema 不兼容，拒绝自动桥接', incompatible_column;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_cache_effectiveness_window" ON "provider_cache_effectiveness" ("provider_id", "model", "window_start" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_replay_payloads_key_id" ON "replay_payloads" ("key_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_replay_payloads_expires_at" ON "replay_payloads" ("expires_at");
--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "discovery_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "discovery_concurrency" integer DEFAULT 2 NOT NULL;
--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "max_discovery_rounds" integer DEFAULT 2 NOT NULL;
--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "discovery_sla_ms" integer DEFAULT 10000 NOT NULL;
--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "sticky_sla_ms" integer DEFAULT 20000 NOT NULL;
--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "racing_total_timeout_ms" integer DEFAULT 60000 NOT NULL;
--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "sticky_timeout_cooldown_ms" integer DEFAULT 300000 NOT NULL;
--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "stream_gate_mode" varchar(10) DEFAULT 'enforce' NOT NULL;
--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "affinity_ignore_client_session_id" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "message_request" ADD COLUMN IF NOT EXISTS "routing_trace" jsonb;
--> statement-breakpoint
ALTER TABLE "message_request" ADD COLUMN IF NOT EXISTS "cache_compatibility_key" varchar(64);
--> statement-breakpoint
ALTER TABLE "message_request" ADD COLUMN IF NOT EXISTS "cache_score_eligible" boolean;
--> statement-breakpoint
ALTER TABLE "message_request" ADD COLUMN IF NOT EXISTS "cache_score_excluded_reason" varchar(32);
--> statement-breakpoint
ALTER TABLE "message_request" ADD COLUMN IF NOT EXISTS "theoretical_cache_tokens" bigint;
--> statement-breakpoint
ALTER TABLE "message_request" ADD COLUMN IF NOT EXISTS "cache_ttl_bucket" varchar(10);
--> statement-breakpoint
DO $$
DECLARE
  incompatible_column text;
BEGIN
  SELECT expected.table_name || '.' || expected.column_name
  INTO incompatible_column
  FROM (VALUES
    ('system_settings', 'discovery_enabled', 'boolean', true, 'false'),
    ('system_settings', 'discovery_concurrency', 'integer', true, '2'),
    ('system_settings', 'max_discovery_rounds', 'integer', true, '2'),
    ('system_settings', 'discovery_sla_ms', 'integer', true, '10000'),
    ('system_settings', 'sticky_sla_ms', 'integer', true, '20000'),
    ('system_settings', 'racing_total_timeout_ms', 'integer', true, '60000'),
    ('system_settings', 'sticky_timeout_cooldown_ms', 'integer', true, '300000'),
    ('system_settings', 'stream_gate_mode', 'character varying(10)', true, '''enforce''::character varying'),
    ('system_settings', 'affinity_ignore_client_session_id', 'boolean', true, 'true'),
    ('message_request', 'routing_trace', 'jsonb', false, NULL),
    ('message_request', 'cache_compatibility_key', 'character varying(64)', false, NULL),
    ('message_request', 'cache_score_eligible', 'boolean', false, NULL),
    ('message_request', 'cache_score_excluded_reason', 'character varying(32)', false, NULL),
    ('message_request', 'theoretical_cache_tokens', 'bigint', false, NULL),
    ('message_request', 'cache_ttl_bucket', 'character varying(10)', false, NULL)
  ) AS expected(table_name, column_name, data_type, required_not_null, expected_default)
  LEFT JOIN pg_class relation ON relation.relname = expected.table_name
    AND relation.relnamespace = 'public'::regnamespace
  LEFT JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
    AND attribute.attname = expected.column_name
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
  LEFT JOIN pg_attrdef attribute_default ON attribute_default.adrelid = relation.oid
    AND attribute_default.adnum = attribute.attnum
  WHERE attribute.attname IS NULL
    OR format_type(attribute.atttypid, attribute.atttypmod) <> expected.data_type
    OR (expected.required_not_null AND NOT attribute.attnotnull)
    OR (
      expected.expected_default IS NOT NULL
      AND pg_get_expr(attribute_default.adbin, attribute_default.adrelid)
        IS DISTINCT FROM expected.expected_default
    )
  LIMIT 1;

  IF incompatible_column IS NOT NULL THEN
    RAISE EXCEPTION '% 结构与最终 schema 不兼容，拒绝自动桥接', incompatible_column;
  END IF;
END $$;
