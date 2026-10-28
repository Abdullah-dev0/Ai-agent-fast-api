-- TanStack AI run store: one row per reply ("run"). reconstructChat asks it
-- for the thread's still-running run, so a reloaded page can rejoin the stream.
-- Timestamps are epoch milliseconds, like the store contract.
CREATE TABLE chat_runs (
  run_id           text PRIMARY KEY,
  thread_id        text NOT NULL,
  status           text NOT NULL,
  started_at       bigint NOT NULL,
  finished_at      bigint,
  error            text,
  error_code       text,
  usage            jsonb,
  sandbox_key      text,
  detached_since   bigint,
  cancel_requested boolean,
  driver_epoch     bigint,
  parent_run_id    text,
  subagent_run_id  text,
  name             text
);

-- findActiveRun: the latest running run for a thread.
CREATE INDEX chat_runs_thread_status_started ON chat_runs (thread_id, status, started_at);
