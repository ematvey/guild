// A stop must end the turn even when the tool inside it cannot be cancelled.
// The worker's abort mark is durable before it waits, so a worker that does
// not settle is killed and its respawn commits the abort from the journal.

import { EventEmitter } from "node:events";
import type { fork } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { ForkSupervisor } from "../worker/supervisor.js";

class FakeChild extends EventEmitter {
  connected = true;
  pid = 1234;
  readonly sent: Record<string, unknown>[] = [];
  readonly killed: string[] = [];
  /** Answers each request of the named kinds as it is sent. */
  answers = new Map<string, unknown>();
  send(message: Record<string, unknown>): void {
    this.sent.push(message);
    if (this.answers.has(message["t"] as string)) {
      setImmediate(() => this.emit("message", { t: "result", ref: message["ref"], ok: true, data: this.answers.get(message["t"] as string) }));
    }
  }
  kill(signal: string): boolean {
    this.killed.push(signal);
    this.emit("exit", null, signal);
    return true;
  }
}

const config = {
  databaseUrl: "postgres://x",
  selfBaseUrl: "http://127.0.0.1:1",
  s3Url: "http://127.0.0.1:2",
  s3Bucket: "b",
  s3AccessKeyId: "k",
  s3SecretAccessKey: "s",
  dataDir: "/tmp",
  sandbox: { mode: "inprocess-unsafe" },
  allowShellTools: true,
  clientToolTimeoutMs: 1000,
  approvalTimeoutMs: 1000,
  logLevel: "silent",
  apiUrl: "http://127.0.0.1:1",
  clickhouseUrl: "http://127.0.0.1:2",
  clickhouseDatabase: "d",
  clickhouseUser: "u",
  clickhousePassword: "p",
  tracePayloads: false,
} as unknown as Config;

const log = { warn: () => {}, error: () => {}, info: () => {} } as unknown as Logger;

function supervisor(child: FakeChild, stopSettleTimeoutMs = 50): ForkSupervisor {
  return new ForkSupervisor(config, log, async () => false, undefined, {
    spawn: (() => child) as unknown as typeof fork,
    stopSettleTimeoutMs,
  });
}

describe("supervisor stop", () => {
  it("kills a worker whose stop does not settle", async () => {
    const child = new FakeChild();
    const sup = supervisor(child);
    const submit = sup.submit("chat-1", {} as never);
    setImmediate(() => child.emit("message", { t: "ready" }));
    child.answers.set("submit", 7);
    await submit;
    await sup.stop("chat-1");
    expect(child.killed).toContain("SIGKILL");
    await sup.close();
  });

  it("leaves a worker that answers the stop running", async () => {
    const child = new FakeChild();
    const sup = supervisor(child);
    const submit = sup.submit("chat-2", {} as never);
    setImmediate(() => child.emit("message", { t: "ready" }));
    child.answers.set("submit", 7);
    await submit;
    child.answers.set("stop", null);
    await sup.stop("chat-2");
    expect(child.killed).toEqual([]);
    await sup.close();
  });

  it("returns at once for a chat no worker owns", async () => {
    const sup = supervisor(new FakeChild());
    await sup.stop("chat-3");
    await sup.close();
  });
});
