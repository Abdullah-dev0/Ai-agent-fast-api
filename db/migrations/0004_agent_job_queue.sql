-- Turns agent_runs into a job queue: the API only enqueues a run, and a
-- separate worker process (agent-server/worker.py) claims and runs it.
-- status is now 'queued', 'running' or 'finished'.

-- The request to run (AG-UI RunAgentInput as JSON), so any worker can run it,
-- and run it again after a crash.
ALTER TABLE agent_runs ADD COLUMN input jsonb;
-- How many times a worker has started this run (a crash makes it retry).
ALTER TABLE agent_runs ADD COLUMN attempts integer NOT NULL DEFAULT 0;

-- What workers look for: queued runs, oldest first.
CREATE INDEX agent_runs_queue ON agent_runs (status, created_at);
