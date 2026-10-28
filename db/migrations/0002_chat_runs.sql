-- TanStack AI run store: one row per reply ("run"). `record` is the RunRecord
-- itself; run_id and thread_id are copied out because the queries look them up.
CREATE TABLE chat_runs (
  run_id    text PRIMARY KEY,
  thread_id text NOT NULL,
  record    jsonb NOT NULL
);

-- findActiveRun: the thread's running run.
CREATE INDEX chat_runs_thread ON chat_runs (thread_id);
