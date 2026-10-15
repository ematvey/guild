// Workspace agent sessions routes:
// create/list/history/run-turn. A session is one durable conversation (its
// 1:1 chat) plus a workspace dir under `workspaces/<org>/<name>` — the
// sandbox the harness's tools execute in (the harness env factory resolves
// it per tool call through agent_sessions).

import { lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ChatsCtx, GatewayCtx, IdentityCtx } from "../contexts.js";
import type { Config } from "../../config.js";
import { ApiError, sortedJson } from "../errors.js";
import { parseUuidParam, requireJsonBody, requireUser } from "./error.js";
import type { UserRow } from "../store/identity.js";
import { uuidv7 } from "../time.js";
import { validWorkspaceName } from "../store/agentSessions.js";
import { threadEventRowWire } from "../domain/thread-events.js";

export function workspaceRoot(config: Config, orgId: string): string {
  return path.join(config.dataDir, "workspaces", orgId);
}

/** The workspace dir for a session name, rejecting traversal/absolute/empty
 *  names (the Rust workspace_boundary_tests contract). */
export function workspaceDir(config: Config, orgId: string, workspaceName: string): string {
  if (!validWorkspaceName(workspaceName)) {
    throw ApiError.badRequest("invalid workspace name");
  }
  return path.join(workspaceRoot(config, orgId), workspaceName);
}

export function registerAgentSessionRoutes(
  app: FastifyInstance,
  chats: ChatsCtx,
  gateway: GatewayCtx,
  auth: IdentityCtx,
  config: Config,
): void {
  /** Creates a session: the name reservation, the chat/session inserts, and
   *  the workspace preparation share one transaction — the rows become
   *  visible only after the orphan reclaim and dir create succeeded. */
  app.post("/api/v1/agents/sessions", async (req, reply) => {
    const user = await requireUser(auth, req);
    const body = requireJsonBody(req);
    const name = body["workspace_name"];
    if (typeof name !== "string") throw ApiError.badRequest("missing workspace_name");
    const dir = workspaceDir(config, user.org_id, name);
    // The rows become visible only after the orphan reclaim and dir create
    // succeeded — the transaction is the store method's.
    const session = await chats.agentSessions.createWithChat(
      user.org_id,
      user.id,
      name,
      (client) =>
        // The chat's title is the workspace name (the Rust create_chat_on call).
        chats.chats.createChatOn(client, user.org_id, user.id, name, null),
      async () => {
        // No committed session holds the name, so any dir still on disk is an
        // orphan a deleted account left behind. Reclaim it — the next user of
        // the same workspace name must not inherit its files. A reclaim that
        // cannot run must fail the request loudly: silently inheriting a
        // foreign directory is the failure this reclaim exists to prevent.
        try {
          // A stale sandbox container of the old owner must not survive
          // into the new session (its files are reclaimed just below).
          await chats.runtime.removeSandbox({ key: `ws:${user.org_id}:${name}`, subpath: `workspaces/${user.org_id}/${name}` });
          // rm never follows symlinks while recursing; the root itself is
          // checked so a planted link cannot redirect the reclaim.
          const stat = await lstat(dir).catch(() => null);
          if (stat?.isSymbolicLink()) throw new Error("workspace dir is a symbolic link");
          await rm(dir, { recursive: true, force: true });
        } catch (error) {
          throw ApiError.internal(`orphan workspace dir reclaim failed: ${String(error)}`);
        }
        try {
          await mkdir(dir, { recursive: true });
        } catch (error) {
          throw ApiError.internal(`workspace dir create failed: ${String(error)}`);
        }
      },
    );
    return reply.status(200).send(JSON.stringify(sortedJson(session)));
  });

  app.get("/api/v1/agents/sessions", async (req, reply) => {
    const user = await requireUser(auth, req);
    const sessions = await chats.agentSessions.list(user.org_id, user.id);
    return reply.status(200).send(JSON.stringify({ sessions: sessions.map((s) => sortedJson(s)) }));
  });

  /** History is the thread journal (org-scoped, owner-or-admin). */
  app.get("/api/v1/agents/sessions/:id", async (req, reply) => {
    const user = await requireUser(auth, req);
    const id = parseUuidParam(req, "id");
    const session = await chats.agentSessions.get(user.org_id, id, user);
    await chats.chats.getChat(user.org_id, session.chat_id, user);
    const rows = await chats.threads.listEvents(user.org_id, session.chat_id);
    // serde_json::json!({"events": rows}): sorted outer keys; each row
    // interpolates as a Value — the byte-exact ThreadEventRow rendering.
    return reply
      .status(200)
      .send(`{"events":[${rows.map(threadEventRowWire).join(",")}]}`);
  });

  /** Submits one turn: the same spend gate + turn pipeline the chat gateway
   *  uses, with `server_workspace` naming the org workspace the tools run
   *  in (the batch contract — exec-policy gated, pre-approved). */
  app.post("/api/v1/agents/sessions/:id/turns", async (req, reply) => {
    const user = await requireUser(auth, req);
    const id = parseUuidParam(req, "id");
    const body = requireJsonBody(req);
    if (typeof body["message"] !== "string") throw ApiError.badRequest("missing message");
    if (typeof body["model"] !== "string") throw ApiError.badRequest("missing model");
    const session = await chats.agentSessions.get(user.org_id, id, user);
    // Same spend gate as the chat gateway: an agent turn is a model call,
    // so the route's monthly quota applies before any tokens flow.
    try {
      const route = await gateway.gatewayStore.resolveRoute(user.org_id, body["model"] as string, gateway.masterKey());
      void route;
    } catch (error) {
      throw ApiError.internal(`route resolve failed: ${String(error)}`);
    }
    const ack = await submitSessionTurn(chats, gateway, user, {
      chat_id: session.chat_id,
      model: body["model"] as string,
      message: body["message"] as string,
      server_workspace: session.workspace_name,
    });
    return reply.status(200).type("application/json").send(ack);
  });
}

interface SessionTurnBody {
  chat_id: string;
  model: string;
  message: string;
  server_workspace: string;
}

/** The agents-session turn path: builds the same canonical request the chat
 *  gateway journals (with server_workspace filled) and reuses the chats
 *  route's submitTurn core via the runtime. */
async function submitSessionTurn(
  chats: ChatsCtx,
  gateway: GatewayCtx,
  user: UserRow,
  body: SessionTurnBody,
): Promise<string> {
  // Quota enforcement rides the gateway route resolution (429 surfaces).
  await gateway.gatewayStore.resolveRoute(user.org_id, body.model, gateway.masterKey());
  const commandId = uuidv7();
  const request = {
    user_message_id: commandId,
    chat_id: body.chat_id,
    model: body.model,
    messages: [{ role: "user", content: body.message }],
    client_tools: false,
    attachment_ids: [],
    server_workspace: body.server_workspace,
  };
  // Same generating reservation as the chats gateway: the accept's echo
  // capture must say generating, or the late socket delivery clobbers the
  // client's optimistic busy. A failed accept or submit restores the
  // previous flag.
  const priorGenerating = await chats.chats.isGenerating(user.org_id, body.chat_id);
  await chats.chats.setGenerating(user.org_id, body.chat_id, true);
  let command;
  try {
    command = await chats.turnCommands.accept(
      commandId,
      user.org_id,
      user.id,
      body.chat_id,
      sortedJson(request),
      {
        user_message_id: commandId,
        org_id: user.org_id,
        user_id: user.id,
        chat_id: body.chat_id,
        model: body.model,
        user_message: body.message,
        client_tools: false,
        project_id: null,
        machine_id: null,
        machine_label: null,
        attachment_ids: [],
        server_workspace: body.server_workspace,
      },
      { content: body.message, attachments: [], queued: priorGenerating },
    );
    const submissionId = await chats.runtime.submitTurn(body.chat_id, user.org_id, {
      orgId: user.org_id,
      requestId: commandId,
      content: body.message,
      images: [],
      model: body.model,
    });
    await chats.turnCommands.submitted(commandId, `sub:${submissionId}`);
  } catch (error) {
    await chats.chats.setGenerating(user.org_id, body.chat_id, priorGenerating);
    await chats.turnCommands.failUnsubmitted(commandId).catch(() => {});
    throw error;
  }
  await chats.chats.setGenerating(user.org_id, body.chat_id, true);
  const refreshed = await chats.turnCommands.existing(commandId, user.org_id, user.id, body.chat_id, sortedJson(request));
  const ack = refreshed ?? command;
  return JSON.stringify(
    sortedJson({
      accepted: true,
      user_message_id: ack.id,
      generation_id: ack.id,
      queued: ack.status === "pending",
      invocation_id: ack.invocation_id,
      status: ack.status,
    }),
  );
}

