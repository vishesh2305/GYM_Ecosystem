ALTER TABLE "organisations" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "published" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "about" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_slug_unique" UNIQUE("slug");