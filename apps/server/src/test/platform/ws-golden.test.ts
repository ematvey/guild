// Golden WS replay: runs the exact scenario captured from the Rust server
// against the TS
// implementation and byte-compares every recorded text frame and HTTP body
// after masking dynamic values (uuids/timestamps/tickets) with the shared
// normalizer. Ping/pong payloads are compared as shape (uuid v7 bytes), not
// bytes — they are per-connection random challenges.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createM5TestEnv, type M5TestEnv } from "./m5-harness.js";
import { runScenario, normalizeFrame, normalizeHexPayload, type ScenarioStep } from "./ws-driver.js";

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "src/test/platform/fixtures/ws-golden.json"), "utf8"),
) as {
  steps: {
    name: string;
    upgradeFailure?: { code: number; message: string };
    http?: { status: number; body: string }[];
    frames: { socket: number; kind: string; data: string }[];
  }[];
};

let env: M5TestEnv;
let base: string;

beforeAll(async () => {
  env = await createM5TestEnv();
  base = await env.listen();
}, 60_000);

afterAll(async () => {
  await env.cleanup();
});

describe("hub WS golden replay (captured from the Rust server)", () => {
  it(
    "replays the full capture byte-identically",
    { timeout: 120_000 },
    async () => {
      const steps: ScenarioStep[] = [];
      await runScenario(
        base,
        {
          machineId: "c0ffee00-0000-4000-8000-00000000c001",
          machineName: "CAPBOX",
          fingerprint: "CAP-FP-1",
          createChatFallback: async (orgId, userId) => {
            await env.db.query(
              "INSERT INTO chats (id, org_id, user_id, title) VALUES (gen_random_uuid(), $1, $2, 'capture')",
              [orgId, userId],
            );
          },
        },
        (step) => steps.push(step),
      );

      expect(steps.map((s) => s.name)).toEqual(fixture.steps.map((s) => s.name));
      for (let i = 0; i < fixture.steps.length; i += 1) {
        const golden = fixture.steps[i]!;
        const actual = steps[i]!;
        const label = `step ${i} (${golden.name})`;

        // HTTP responses: status + normalized body bytes.
        const goldenHttp = golden.http ?? [];
        const actualHttp = actual.http ?? [];
        expect(actualHttp.length, label).toBe(goldenHttp.length);
        for (let h = 0; h < goldenHttp.length; h += 1) {
          expect(actualHttp[h]!.status, `${label} http[${h}] status`).toBe(goldenHttp[h]!.status);
          expect(normalizeFrame(actualHttp[h]!.body), `${label} http[${h}] body`).toBe(
            goldenHttp[h]!.body,
          );
        }

        // Handshake rejections: status code (+ body bytes when captured).
        if (golden.upgradeFailure !== undefined) {
          expect(actual.upgradeFailure?.code, `${label} upgrade status`).toBe(
            golden.upgradeFailure.code,
          );
          if (golden.upgradeFailure.message.startsWith("{")) {
            expect(normalizeFrame(actual.upgradeFailure?.message ?? ""), `${label} upgrade body`).toBe(
              golden.upgradeFailure.message,
            );
          }
        } else {
          expect(actual.upgradeFailure ?? null, label).toBeNull();
        }

        // Frames: kinds and (masked) payload bytes.
        const goldenFrames = golden.frames.map((f) => ({
          socket: f.socket,
          kind: f.kind,
          data: f.kind === "text" ? f.data : normalizeHexPayload(f.data),
        }));
        const actualFrames = actual.frames.map(({ socket, frame: f }) => ({
          socket,
          kind: f.kind,
          data: f.kind === "text" ? normalizeFrame(f.data) : normalizeHexPayload(f.data),
        }));
        expect(actualFrames.map((f) => `${f.socket}:${f.kind}`), label).toEqual(
          goldenFrames.map((f) => `${f.socket}:${f.kind}`),
        );
        for (let f = 0; f < goldenFrames.length; f += 1) {
          const g = goldenFrames[f]!;
          const a = actualFrames[f]!;
          if (g.kind === "text") {
            expect(a.data, `${label} frame[${f}] bytes`).toBe(g.data);
          } else if (g.data.startsWith("__UUIDBYTES_v")) {
            // Both sides must send 16-byte uuid v7 challenges.
            expect(a.data, `${label} frame[${f}] challenge shape`).toBe("__UUIDBYTES_v7__");
            expect(g.data, `${label} frame[${f}] golden challenge shape`).toBe("__UUIDBYTES_v7__");
          } else {
            expect(a.data, `${label} frame[${f}] control bytes`).toBe(g.data);
          }
        }
      }
    },
  );
});
