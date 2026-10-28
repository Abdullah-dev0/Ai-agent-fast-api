import "server-only";
import { defineAIPersistence, defineMessageStore, defineRunStore } from "@tanstack/ai-persistence";
import type { ChatTranscriptPersistence, RunRecord } from "@tanstack/ai-persistence";
import type { ModelMessage } from "@tanstack/ai";
import { pool } from "./db";

/**
 * Message store: the transcript survives a reload.
 * Run store: lets a reloaded page find a reply that is still streaming and
 * rejoin it. Each run is stored as one jsonb record, so nothing is mapped.
 */
export const chatPersistence: ChatTranscriptPersistence = defineAIPersistence({
  stores: {
    messages: defineMessageStore({
      async loadThread(threadId) {
        const { rows } = await pool.query<{ messages: Array<ModelMessage> }>(
          "SELECT messages FROM chat_threads WHERE thread_id = $1",
          [threadId],
        );
        // Unknown thread: [] (never null).
        return rows[0]?.messages ?? [];
      },
      // Full overwrite: `messages` is the complete merged transcript.
      async saveThread(threadId, messages) {
        await pool.query(
          `INSERT INTO chat_threads (thread_id, messages) VALUES ($1, $2)
           ON CONFLICT (thread_id) DO UPDATE SET messages = EXCLUDED.messages, updated_at = now()`,
          [threadId, JSON.stringify(messages)],
        );
      },
    }),
    runs: defineRunStore({
      async get(runId) {
        const { rows } = await pool.query<{ record: RunRecord }>("SELECT record FROM chat_runs WHERE run_id = $1", [runId]);
        return rows[0]?.record ?? null;
      },
      // Insert-if-absent: on conflict the no-op update lets RETURNING give back the stored run unchanged.
      async createOrResume({ runId, threadId, status = "running", startedAt }) {
        const record: RunRecord = { runId, threadId, status, startedAt };
        const { rows } = await pool.query<{ record: RunRecord }>(
          `INSERT INTO chat_runs (run_id, thread_id, record) VALUES ($1, $2, $3)
           ON CONFLICT (run_id) DO UPDATE SET run_id = EXCLUDED.run_id
           RETURNING record`,
          [runId, threadId, JSON.stringify(record)],
        );
        return rows[0].record;
      },
      // Merge the changed fields into the record; an unknown runId updates nothing.
      async update(runId, patch) {
        await pool.query("UPDATE chat_runs SET record = record || $2 WHERE run_id = $1", [runId, JSON.stringify(patch)]);
      },
      async findActiveRun(threadId) {
        const { rows } = await pool.query<{ record: RunRecord }>(
          `SELECT record FROM chat_runs WHERE thread_id = $1 AND record->>'status' = 'running'
           ORDER BY (record->>'startedAt')::bigint DESC LIMIT 1`,
          [threadId],
        );
        return rows[0]?.record ?? null;
      },
    }),
  },
});

/** Delete a thread's messages and run records. Callers must check ownership first. */
export async function deleteThread(threadId: string): Promise<void> {
  await pool.query("DELETE FROM chat_runs WHERE thread_id = $1", [threadId]);
  await pool.query("DELETE FROM chat_threads WHERE thread_id = $1", [threadId]);
}

/** One thread per user, derived on the server so a client cannot pick someone else's. */
export function threadIdFor(userId: string): string {
  return `user:${userId}`;
}
