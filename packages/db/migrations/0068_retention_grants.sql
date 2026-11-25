-- The retention job (apps/api/src/privacy/retention.ts) runs as app_privacy, like export and erasure.
GRANT DELETE ON sessions TO app_privacy;
--> statement-breakpoint
GRANT UPDATE (content) ON member_imports TO app_privacy;
