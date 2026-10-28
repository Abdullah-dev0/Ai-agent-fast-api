import "server-only";
import { defineAIPersistence, defineMessageStore, defineRunStore } from "@tanstack/ai-persistence";
import type { ChatTranscriptPersistence, RunRecord, RunStatus } from "@tanstack/ai-persistence";
import type { ModelMessage } from "@tanstack/ai";
import { pool } from "./db";

// The `status` column is text; validate it back into the union (no cast).
function toRunStatus(value: unknown): RunStatus {
  switch (value) {
    case "running":
    case "interrupted":
    case "completed":
    case "failed":
    case "aborted":
      return value;
    default:
      throw new TypeError(`Unexpected run status: ${String(value)}`);
  }
}

// pg returns bigint columns as strings, so convert epoch ms with Number().
// Absent optionals are left out, so records match the reference store.
function mapRun(row: Record<string, unknown>): RunRecord {
  return {
    runId: String(row.run_id),
    threadId: String(row.thread_id),
    status: toRunStatus(row.status),
    startedAt: Number(row.started_at),
    ...(row.finished_at != null ? { finishedAt: Number(row.finished_at) } : {}),
    ...(typeof row.error === "string"
      ? { error: { message: row.error, ...(typeof row.error_code === "string" ? { code: row.error_code } : {}) } }
      : {}),
    ...(row.usage != null ? { usage: row.usage as RunRecord["usage"] } : {}),
  };
}

async function getRun(runId: string): Promise<RunRecord | null> {
  const { rows } = await pool.query("SELECT * FROM chat_runs WHERE run_id = $1", [runId]);
  return rows[0] ? mapRun(rows[0]) : null;
}

/**
 * Message store: the transcript survives a reload.
 * Run store: reconstructChat can tell a reloaded page that a reply is still
 * streaming, so the page rejoins it from the stream log (see app/api/chat).
 * Chat-app fields only: the sandbox and subagent fields are for durable
 * sandboxed agents, which this app does not run.
 */
export const chatPersistence: ChatTranscriptPersistence = defineAIPersistence({
  stores: {
    runs: defineRunStore({
      get: getRun,
      // Insert-if-absent: an existing runId comes back unchanged.
      async createOrResume(input) {
        await pool.query(
          `INSERT INTO chat_runs (run_id, thread_id, status, started_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (run_id) DO NOTHING`,
          [input.runId, input.threadId, input.status ?? "running", input.startedAt],
        );
        // Re-read: a concurrent call may have won the insert, and its row wins.
        const stored = await getRun(input.runId);
        if (!stored) throw new Error(`Run ${input.runId} vanished after insert`);
        return stored;
      },
      // Only patched fields change; an unknown runId updates zero rows (a no-op).
      async update(runId, patch) {
        const sets: Array<string> = [];
        const params: Array<unknown> = [];
        const set = (column: string, value: unknown) => {
          params.push(value);
          sets.push(`${column} = $${params.length}`);
        };
        if (patch.status !== undefined) set("status", patch.status);
        if (patch.finishedAt !== undefined) set("finished_at", patch.finishedAt);
        if (patch.error !== undefined) {
          // Both halves together, so a code-less failure can't keep an old code.
          set("error", patch.error.message);
          set("error_code", patch.error.code ?? null);
        }
        if (patch.usage !== undefined) set("usage", JSON.stringify(patch.usage));
        if (sets.length === 0) return;
        params.push(runId);
        await pool.query(`UPDATE chat_runs SET ${sets.join(", ")} WHERE run_id = $${params.length}`, params);
      },
      async findActiveRun(threadId) {
        const { rows } = await pool.query(
          `SELECT * FROM chat_runs WHERE thread_id = $1 AND status = 'running'
           ORDER BY started_at DESC LIMIT 1`,
          [threadId],
        );
        return rows[0] ? mapRun(rows[0]) : null;
      },
    }),
    messages: defineMessageStore({
      async loadThread(threadId) {
        const { rows } = await pool.query<{ messages: Array<ModelMessage> }>(
          "SELECT messages FROM chat_threads WHERE thread_id = $1",
          [threadId],
        );
        // pg parses jsonb for us. Unknown thread: [] (never null).
        return rows[0]?.messages ?? [];
      },
      // Full overwrite: `messages` is the complete merged transcript.
      async saveThread(threadId, messages) {
        await pool.query(
          `INSERT INTO chat_threads (thread_id, messages, updated_at)
           VALUES ($1, $2::jsonb, now())
           ON CONFLICT (thread_id)
           DO UPDATE SET messages = EXCLUDED.messages, updated_at = EXCLUDED.updated_at`,
          [threadId, JSON.stringify(messages)],
        );
      },
    }),
  },
});

/** One thread per user, derived on the server so a client cannot pick someone else's. */
export function threadIdFor(userId: string): string {
  return `user:${userId}`;
}
