-- A user's monthly token limit. No row means no limit. The agent server
-- (agent-server/agent.py) checks it before every model call and stops the reply
-- once this calendar month's tokens (UTC) reach the limit.
CREATE TABLE usage_budgets (
  user_id text PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
  monthly_token_limit bigint NOT NULL CHECK (monthly_token_limit > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
