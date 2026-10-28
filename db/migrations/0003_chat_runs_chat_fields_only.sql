-- The run store only keeps the fields a chat app uses. The sandbox fields are
-- for durable sandboxed agents and the subagent fields for subagent runs;
-- this app runs neither.
ALTER TABLE chat_runs
  DROP COLUMN sandbox_key,
  DROP COLUMN detached_since,
  DROP COLUMN cancel_requested,
  DROP COLUMN driver_epoch,
  DROP COLUMN parent_run_id,
  DROP COLUMN subagent_run_id,
  DROP COLUMN name;
