-- Tokens per model call, written by the agent server (agent-server/agent.py).
-- One reply can be several calls. No foreign keys: the rows outlive a cleared
-- chat (the checkpointer deletes its copy of the counts then).
CREATE TABLE token_usage (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL,
  thread_id text NOT NULL,
  message_id text,
  provider text NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL,
  output_tokens integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX token_usage_user_created_idx ON token_usage (user_id, created_at);
