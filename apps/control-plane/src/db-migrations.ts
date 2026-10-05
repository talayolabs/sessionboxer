/**
 * Columns added after the first release, applied to databases created before them. The per-setting
 * columns of old databases (docker_mode, auto_snapshot, mcp_enabled, model, options, instructions,
 * inspect_llm, git_user_name, git_user_email) are left in place and folded into `settings` once.
 */
export const MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: "sessions", column: "queue_running", ddl: "ALTER TABLE sessions ADD COLUMN queue_running INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "disk_bytes", ddl: "ALTER TABLE sessions ADD COLUMN disk_bytes INTEGER" },
  { table: "sessions", column: "mcp_pending", ddl: "ALTER TABLE sessions ADD COLUMN mcp_pending INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "model_pending", ddl: "ALTER TABLE sessions ADD COLUMN model_pending INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "options_pending", ddl: "ALTER TABLE sessions ADD COLUMN options_pending INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "available_options", ddl: "ALTER TABLE sessions ADD COLUMN available_options TEXT NOT NULL DEFAULT '[]'" },
  { table: "sessions", column: "active_branch_id", ddl: "ALTER TABLE sessions ADD COLUMN active_branch_id TEXT NOT NULL DEFAULT 'root'" },
  { table: "sessions", column: "inspect_llm_pending", ddl: "ALTER TABLE sessions ADD COLUMN inspect_llm_pending INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "usage", ddl: "ALTER TABLE sessions ADD COLUMN usage TEXT NOT NULL DEFAULT '{}'" },
  { table: "sessions", column: "repos", ddl: "ALTER TABLE sessions ADD COLUMN repos TEXT NOT NULL DEFAULT '[]'" },
  { table: "sessions", column: "settings", ddl: "ALTER TABLE sessions ADD COLUMN settings TEXT" },
  { table: "sessions", column: "usb", ddl: "ALTER TABLE sessions ADD COLUMN usb TEXT" },
  { table: "sessions", column: "created_by", ddl: "ALTER TABLE sessions ADD COLUMN created_by TEXT" },
  { table: "sessions", column: "pinned", ddl: "ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "folder_id", ddl: "ALTER TABLE sessions ADD COLUMN folder_id TEXT" },
  { table: "sessions", column: "image", ddl: "ALTER TABLE sessions ADD COLUMN image TEXT" },
  { table: "e2e_runs", column: "brief", ddl: "ALTER TABLE e2e_runs ADD COLUMN brief TEXT" },
  { table: "snapshots", column: "branch_id", ddl: "ALTER TABLE snapshots ADD COLUMN branch_id TEXT NOT NULL DEFAULT 'root'" },
  { table: "snapshots", column: "providers", ddl: "ALTER TABLE snapshots ADD COLUMN providers TEXT" },
  { table: "snapshots", column: "payloads", ddl: "ALTER TABLE snapshots ADD COLUMN payloads TEXT" },
  { table: "events", column: "branch_id", ddl: "ALTER TABLE events ADD COLUMN branch_id TEXT NOT NULL DEFAULT 'root'" },
];
