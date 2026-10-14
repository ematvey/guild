// Golden WS fixture capture against the REAL Rust server (crates/server,
// built locally, disposable database). Writes
// src/test/platform/fixtures/ws-golden.json — raw frame bytes with dynamic
// values masked by the shared normalizer. Run: npx tsx scripts/capture-ws-fixtures.mjs

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { runScenario, normalizeFrame, normalizeHexPayload } from "../src/test/platform/ws-driver.ts";

const BASE = process.env.CAPTURE_BASE ?? "http://127.0.0.1:18190";

const steps = [];
await runScenario(BASE, { machineId: "c0ffee00-0000-4000-8000-00000000c001", machineName: "CAPBOX", fingerprint: "CAP-FP-1" }, (step) => steps.push(step));

const out = {
  _comment:
    "Golden hub-WS fixtures captured from the Rust server (crates/server @ this commit), disposable database, scripted ws client (apps/server ws-driver). Frames byte-compared in replay; dynamic values masked with the same normalizer.",
  base_commit: process.env.CAPTURE_COMMIT ?? "unknown",
  steps: steps.map((step) => ({
    name: step.name,
    upgradeFailure: step.upgradeFailure ?? undefined,
    http: step.http?.map((h) => ({ status: h.status, body: normalizeFrame(h.body) })),
    frames: step.frames.map(({ socket, frame }) => ({
      socket,
      kind: frame.kind,
      data: frame.kind === "text" ? normalizeFrame(frame.data) : normalizeHexPayload(frame.data),
    })),
  })),
};

const fixturePath = path.resolve(process.cwd(), "src/test/platform/fixtures/ws-golden.json");
mkdirSync(path.dirname(fixturePath), { recursive: true });
writeFileSync(fixturePath, `${JSON.stringify(out, null, 2)}\n`);
console.log(`captured ${steps.length} steps -> ${fixturePath}`);
for (const step of steps) {
  console.log(
    `  ${step.name}: frames=${step.frames.length} http=${step.http?.length ?? 0} upgradeFailure=${step.upgradeFailure ? step.upgradeFailure.code : "-"}`,
  );
}
void readFileSync;
void existsSync;
