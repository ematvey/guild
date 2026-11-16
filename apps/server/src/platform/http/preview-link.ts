// Signed preview links: a file the browser renders in a frame cannot carry an
// Authorization header, so the server mints a short-lived URL for it. The
// signature covers the kind, the id and the expiry; the response that serves
// the bytes sets its own sandboxing policy, so the framed page runs with an
// opaque origin and cannot touch this app's storage or DOM.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { AttachmentStore } from "../store/attachments.js";
import type { ChatsCtx, IdentityCtx } from "../route-contexts.js";
import { ApiError } from "../errors.js";
import { queryParam, requireUser, sendJson } from "./error.js";

/** A file the preview pane can show. */
export type PreviewKind = "attachment" | "artifact";

/** How long a minted link stays valid: long enough to open and reload, short
 *  enough that a leaked URL dies. */
export const PREVIEW_LINK_TTL_SECONDS = 600;

const pathOf = (kind: PreviewKind, id: string): string =>
  kind === "attachment" ? `/api/v1/attachments/${id}` : `/api/v1/tool_artifacts/${id}`;

const signature = (secret: string, kind: PreviewKind, id: string, exp: number): string =>
  createHmac("sha256", secret).update(`preview:${kind}:${id}:${exp}`).digest("hex");

/** The path the preview frame loads: the byte route plus `?preview=exp.sig`
 *  and `inline=1`. */
export function previewLinkPath(secret: string, kind: PreviewKind, id: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + PREVIEW_LINK_TTL_SECONDS;
  return `${pathOf(kind, id)}?inline=1&preview=${exp}.${signature(secret, kind, id, exp)}`;
}

/** Throws when the value is missing, expired or forged. */
export function verifyPreviewLink(secret: string, kind: PreviewKind, id: string, value: string): void {
  const [rawExp, sig] = value.split(".");
  const exp = Number(rawExp);
  if (!Number.isFinite(exp) || sig === undefined) throw ApiError.unauthorized("bad preview link");
  if (exp < Math.floor(Date.now() / 1000)) throw ApiError.unauthorized("preview link expired");
  const expected = signature(secret, kind, id, exp);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw ApiError.unauthorized("bad preview link");
}

/** Sends the bytes of a signed preview: inline, under the sandboxing policy
 *  below. The client frames this URL directly, so nothing is minted as a
 *  blob and the page keeps its own resource policy. */
export function previewReply(
  reply: { status: (code: number) => any },
  bytes: Buffer | Readable,
  row: { filename: string; content_type: string },
): unknown {
  return reply
    .status(200)
    .type(row.content_type)
    .header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`)
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", PREVIEW_CSP)
    .send(bytes);
}

/** The policy a previewed file is served under: `sandbox` forces an opaque
 *  origin even though the URL is same-origin, and the resource policy lets
 *  the page render its own inline styles and scripts. */
export const PREVIEW_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-modals; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self'";

/** `GET /api/v1/preview_link?kind=<attachment|artifact>&id=<uuid>`: the signed
 *  URL the preview pane frames. The read gate is the byte route's own — the
 *  chat's read rule for an attachment, the executor rule for an artifact — so
 *  a link can only be minted by someone who could already download the file. */
export function registerPreviewLinkRoutes(
  app: FastifyInstance,
  chats: ChatsCtx,
  ctx: IdentityCtx & { readonly attachments: AttachmentStore },
): void {
  app.get("/api/v1/preview_link", async (req, reply) => {
    const user = await requireUser(ctx, req);
    const kind = queryParam(req, "kind");
    const id = queryParam(req, "id");
    if ((kind !== "attachment" && kind !== "artifact") || id === undefined || !UUID_RE.test(id)) {
      throw ApiError.badRequest("bad preview link request");
    }
    const chatId =
      kind === "attachment"
        ? (await ctx.attachments.get(user.org_id, id)).chat_id
        : (await chats.toolArtifacts.get(user.org_id, id)).chat_id;
    await chats.chats.getChat(user.org_id, chatId, user);
    return sendJson(reply, { path: previewLinkPath(ctx.config.jwtSecret, kind, id) });
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
