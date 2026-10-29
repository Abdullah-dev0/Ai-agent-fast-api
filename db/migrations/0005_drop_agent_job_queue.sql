-- The agent's job queue and reply logs (old 0003 and 0004) are gone: replies now
-- run inside the request (ag-ui-langgraph's endpoint). Drops the tables on
-- databases that still have them; does nothing on new ones.
DROP TABLE IF EXISTS agent_run_events;
DROP TABLE IF EXISTS agent_runs;
