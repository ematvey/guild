// Staging a file the server holds: the bytes go into the chat's artifact
// store, and the executor that needs the file pulls it by id. A machine
// never receives file content over the socket — it fetches the artifact
// with its own session (fs.fetch_v1).

import { randomUUID } from "node:crypto";
import type { ObjectStore } from "../platform/s3.js";
import type { ToolArtifactStore } from "../platform/store/tool-artifacts.js";
import { spillArtifact } from "./spill.js";

/** The last path segment of a model-named destination, as a filename. */
function basename(name: string): string {
  const tail = name.split(/[\\/]/).pop() ?? "";
  return tail === "" ? "file.bin" : tail;
}

/** Binds the staging step to one chat: bytes in, artifact id out. */
export function chatStager(
  artifacts: ToolArtifactStore,
  objects: ObjectStore,
  orgId: string,
  chatId: string,
): (bytes: Uint8Array, name: string) => Promise<string> {
  return async (bytes, name) => {
    const staged = await spillArtifact(
      artifacts,
      objects,
      orgId,
      chatId,
      randomUUID(),
      "file",
      basename(name),
      "application/octet-stream",
      Buffer.from(bytes),
    );
    return staged.artifact_id;
  };
}
