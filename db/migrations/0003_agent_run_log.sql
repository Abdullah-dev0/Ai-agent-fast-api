-- The Python agent's reply logs (agent-server/runs.py). Kept in Postgres instead
-- of memory, so a reply survives a server restart and any server can serve it.

-- One row per reply ("run").
CREATE TABLE agent_runs (
  run_id           text PRIMARY KEY,
  thread_id        text NOT NULL,
  status           text NOT NULL DEFAULT 'running',  -- 'running' or 'finished'
  cancel_requested boolean NOT NULL DEFAULT false,   -- set by POST /agent/stop
  heartbeat_at     timestamptz NOT NULL DEFAULT now(), -- refreshed while running
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- "Is a reply running for this thread?"
CREATE INDEX agent_runs_thread_status ON agent_runs (thread_id, status);

-- Every event of a run, numbered 1, 2, 3... in order. `event` is the encoded
-- SSE text ("data: {...}\n\n") exactly as it goes to the browser.
CREATE TABLE agent_run_events (
  run_id text NOT NULL REFERENCES agent_runs ON DELETE CASCADE,
  seq    integer NOT NULL,
  event  text NOT NULL,
  PRIMARY KEY (run_id, seq)
);
