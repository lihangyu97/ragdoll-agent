CREATE TABLE `agent_threads` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`chat_type` text NOT NULL,
	`chat_id` text NOT NULL,
	`sender_id` text,
	`agent_id` text,
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
	`channel` text,
	`input_text` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`heartbeat_at` text,
	`created_at` text DEFAULT (datetime('now', 'localtime')),
	`updated_at` text DEFAULT (datetime('now', 'localtime')),
	FOREIGN KEY (`thread_id`) REFERENCES `agent_threads`(`thread_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_traces_status_created_at` ON `agent_traces` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_turns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` text NOT NULL,
	`turn_no` integer NOT NULL,
	`hook_type` text NOT NULL,
	`node` text,
	`tool_call_id` text,
	`tool_name` text,
	`args` text,
	`content` text,
	`tools_result` text,
	`created_at` text DEFAULT (datetime('now', 'localtime'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_turns_thread_turn_input` ON `agent_turns` (`thread_id`,`turn_no`) WHERE hook_type = 'INPUT';--> statement-breakpoint
CREATE TABLE `channel_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`message_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`chat_type` text NOT NULL,
	`thread_id` text,
	`sender_id` text,
	`sender_name` text,
	`text` text,
	`extra` text,
	`created_at` text DEFAULT (datetime('now', 'localtime'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_messages_channel_message_id` ON `channel_messages` (`channel`,`message_id`);--> statement-breakpoint
CREATE TABLE `channel_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (datetime('now', 'localtime')),
	`updated_at` text DEFAULT (datetime('now', 'localtime'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_users_channel_user_id` ON `channel_users` (`channel`,`user_id`);--> statement-breakpoint
CREATE TABLE `logger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`data` text,
	`thread_id` text,
	`created_at` text DEFAULT (datetime('now', 'localtime'))
);
