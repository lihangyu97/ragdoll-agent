CREATE TABLE `agent_threads` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`chat_type` text NOT NULL,
	`chat_id` text NOT NULL,
	`sender_open_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (datetime('now', 'localtime')),
	`updated_at` text DEFAULT (datetime('now', 'localtime'))
);
--> statement-breakpoint
CREATE TABLE `agent_traces` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` text NOT NULL,
	`message_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`input_text` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (datetime('now', 'localtime')),
	`updated_at` text DEFAULT (datetime('now', 'localtime')),
	FOREIGN KEY (`thread_id`) REFERENCES `agent_threads`(`thread_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `agent_turns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` text NOT NULL,
	`turn_no` integer NOT NULL,
	`hook_type` text NOT NULL,
	`node` text,
	`msg_type` text,
	`tool_call_id` text,
	`tool_calls` text,
	`content` text,
	`tools_result` text,
	`created_at` text DEFAULT (datetime('now', 'localtime'))
);
--> statement-breakpoint
CREATE TABLE `channel_lark` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_type` text NOT NULL,
	`app_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`chat_type` text NOT NULL,
	`message_id` text NOT NULL,
	`message_type` text NOT NULL,
	`thread_id` text,
	`sender_open_id` text,
	`sender_type` text NOT NULL,
	`sender_name` text,
	`content` text,
	`created_at` text DEFAULT (datetime('now', 'localtime'))
);
--> statement-breakpoint
CREATE TABLE `channel_lark_user` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`open_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (datetime('now', 'localtime')),
	`updated_at` text DEFAULT (datetime('now', 'localtime'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_lark_user_open_id_unique` ON `channel_lark_user` (`open_id`);--> statement-breakpoint
CREATE TABLE `logger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`data` text,
	`thread_id` text,
	`created_at` text DEFAULT (datetime('now', 'localtime'))
);
