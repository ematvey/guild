// The main server ↔ worker IPC protocol. One forked worker process owns
// one conversation's scoped harness (worker/main.ts); the supervisor routes
// admission and control over this channel. Frames and approval decisions
// deliberately do NOT ride here: the worker's bridge writes thread_events +
// pg_notify through the shared database, and the approval gate polls the
// journaled decision — both cross the process boundary through Postgres.

/** What the server routes into a worker. `SubmitTurnInput` is the same
 *  shape the HTTP routes assemble; the worker runs the full admission
 *  path (conversation bootstrap, configure, integrations, submit). */
export type WorkerRequest =
  | { t: "submit"; ref: number; input: {
      orgId: string;
      requestId: string;
      content: string;
      images: { mimeType: string; data: string }[];
      model: string | null;
      sendMode?: "steer" | "queue";
      skillsIndex?: string;
    } }
  | { t: "withdraw"; ref: number; submissionId: number }
  | { t: "stop"; ref: number }
  | { t: "compact"; ref: number };

export type WorkerResponse =
  | { t: "result"; ref: number; ok: true; data: unknown }
  | { t: "result"; ref: number; ok: false; error: string };

export type WorkerEvent =
  | { t: "ready" }
  | { t: "heartbeat" };

export type WorkerMessage = WorkerRequest | WorkerResponse | WorkerEvent;
