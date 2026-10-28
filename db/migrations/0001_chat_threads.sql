-- TanStack AI message store: one row per thread, holding the full transcript.
-- saveThread overwrites `messages` with the complete merged history every turn.
CREATE TABLE chat_threads (
  thread_id  text PRIMARY KEY,
  messages   jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
