SELECT app.enable_user_rls('workouts');
--> statement-breakpoint
SELECT app.enable_user_rls('workout_sets');
--> statement-breakpoint
SELECT app.enable_user_rls('workout_templates');
--> statement-breakpoint

-- Logical replication source for the PowerSync service, which streams these tables to phones according to
-- packages/db/powersync/sync-rules.yaml. Only tables named in the sync rules belong here.
CREATE PUBLICATION powersync FOR TABLE exercises, workouts, workout_sets, workout_templates;
