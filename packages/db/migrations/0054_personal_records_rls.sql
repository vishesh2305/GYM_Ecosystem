SELECT app.enable_user_rls('personal_records');
--> statement-breakpoint
ALTER PUBLICATION powersync ADD TABLE personal_records;
