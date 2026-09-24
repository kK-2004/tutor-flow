ALTER TABLE `content_job` ADD `research_mode` text DEFAULT 'search' NOT NULL;--> statement-breakpoint
ALTER TABLE `content_job` ADD `research_document_ids` text DEFAULT '[]' NOT NULL;