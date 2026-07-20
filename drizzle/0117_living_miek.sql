ALTER TABLE "providers" ADD COLUMN "circuit_breaker_rolling_window_duration" integer DEFAULT 60000;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "circuit_breaker_minimum_samples" integer DEFAULT 20;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "circuit_breaker_failure_rate_threshold" numeric(5, 4) DEFAULT '0.4';--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "circuit_breaker_consecutive_failure_threshold" integer DEFAULT 8;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "circuit_breaker_half_open_max_concurrency" integer DEFAULT 2;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "circuit_breaker_half_open_lease_duration" integer DEFAULT 120000;