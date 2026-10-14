// Minimal Docker Engine API client over the unix socket: JSON requests plus
// the hijacked exec stream (stdin raw, stdout/stderr multiplexed).

import http from "node:http";
import type { Duplex } from "node:stream";

const API = "/v1.47";

export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ExecStream {
  /** Raw stdin of the exec'd process. */
  stdin: Duplex;
  onStdout(listener: (chunk: Buffer) => void): void;
  onStderr(listener: (chunk: Buffer) => void): void;
  onEnd(listener: () => void): void;
  close(): void;
}

export class DockerClient {
  constructor(private readonly socketPath: string) {}

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise<T>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path: `${API}${path}`,
          headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            if (status >= 400) {
              let message = text;
              try {
                message = (JSON.parse(text) as { message?: string }).message ?? text;
              } catch {
                // plain text error body
              }
              reject(new DockerError(status, `docker ${method} ${path}: ${status} ${message}`));
              return;
            }
            if (text === "") resolve(undefined as T);
            else {
              try {
                resolve(JSON.parse(text) as T);
              } catch {
                resolve(text as T);
              }
            }
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** Starts an exec and returns its hijacked stream (Tty off: stdout and
   *  stderr arrive multiplexed with 8-byte frame headers). */
  async execAttach(execId: string): Promise<ExecStream> {
    const payload = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
    const socket = await new Promise<Duplex>((resolve, reject) => {
      const req = http.request({
        socketPath: this.socketPath,
        method: "POST",
        path: `${API}/exec/${execId}/start`,
        headers: {
          "content-type": "application/json",
          "content-length": payload.length,
          connection: "Upgrade",
          upgrade: "tcp",
        },
      });
      req.on("upgrade", (_res, sock, head) => {
        if (head.length > 0) sock.unshift(head);
        resolve(sock);
      });
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => reject(new DockerError(res.statusCode ?? 0, `exec start: ${Buffer.concat(chunks).toString("utf8")}`)));
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });

    const stdout: Array<(chunk: Buffer) => void> = [];
    const stderr: Array<(chunk: Buffer) => void> = [];
    const ends: Array<() => void> = [];
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      for (const l of ends) l();
    };
    let pending: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= 8) {
        const size = pending.readUInt32BE(4);
        if (pending.length < 8 + size) break;
        const stream = pending[0];
        const frame = pending.subarray(8, 8 + size);
        pending = pending.subarray(8 + size);
        for (const l of stream === 2 ? stderr : stdout) l(frame);
      }
    });
    socket.on("end", end);
    socket.on("close", end);
    socket.on("error", end);
    return {
      stdin: socket,
      onStdout: (l) => stdout.push(l),
      onStderr: (l) => stderr.push(l),
      onEnd: (l) => (ended ? l() : ends.push(l)),
      close: () => {
        // Half-close: the agent sees stdin end and exits after cleanup.
        socket.end();
        setTimeout(() => socket.destroy(), 10_000).unref();
      },
    };
  }
}
