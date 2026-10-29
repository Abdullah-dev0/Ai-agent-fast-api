-- The simple /chat page's message and run stores (old 0001 and 0002) are gone:
-- the agent keeps conversations in LangGraph's checkpointer. Drops the tables on
-- databases that still have them; does nothing on new ones.
DROP TABLE IF EXISTS chat_runs;
DROP TABLE IF EXISTS chat_threads;
