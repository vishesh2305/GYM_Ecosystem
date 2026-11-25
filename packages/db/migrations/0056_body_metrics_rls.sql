SELECT app.enable_user_rls('body_metrics');
--> statement-breakpoint
ALTER PUBLICATION powersync ADD TABLE body_metrics;
