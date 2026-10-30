-- A user's chats. The messages stay in LangGraph's checkpointer: chats.id is the
-- thread_id there. A null title means nothing has been sent yet.
CREATE TABLE chats (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chats_user_updated_idx ON chats (user_id, updated_at DESC);

-- Keep the chats from when each user had one thread, tanstack:<user id>. The
-- checkpointer makes its tables at server start, so a new database has none yet.
DO $$
BEGIN
  IF to_regclass('checkpoints') IS NOT NULL THEN
    INSERT INTO chats (id, user_id, title)
    SELECT DISTINCT c.thread_id, u.id, 'Earlier chat'
    FROM checkpoints c
    JOIN "user" u ON c.thread_id = 'tanstack:' || u.id;
  END IF;
END $$;
