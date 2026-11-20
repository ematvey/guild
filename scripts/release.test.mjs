import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  assemble,
  checkPolicy,
  filenames,
  PLATFORMS,
  previewVersion,
  versions,
  verifyReleaseCommit,
} from "./release.mjs";

const files = [
  "Cargo.toml",
  "Cargo.lock",
  "apps/desktop/src-tauri/tauri.conf.json",
  "apps/desktop/package.json",
  "apps/server/package.json",
  "packages/ui/package.json",
  "package-lock.json",
];
const original = Object.fromEntries(files.map((f) => [f, readFileSync(new URL(`../${f}`, import.meta.url), "utf8")]));
const baseline = versions((f) => original[f]);
const snapshot = (version) => (f) => original[f].replaceAll(baseline, version);
const before = snapshot("1.2.3"),
  after = snapshot("1.2.4"),
  master = after;

test("preview builds use next patch and a numeric build identifier, without changing the source version", () => {
  assert.equal(previewVersion("1.2.3", 42), "1.2.4-dev.42");
  assert.equal(previewVersion("1.2.3", 1795164000123), "1.2.4-dev.1795164000123");
  for (const n of ["0", "01", "-1", "abc", "1; exit 0"]) assert.throws(() => previewVersion("1.2.3", n));
  assert.throws(() => previewVersion("1.2.4-dev.1", 2));
});

test("branch policy rejects bumps, preview stamps and inconsistent version files", () => {
  const policy = { before, after, master: before, branch: "develop" };
  assert.throws(() => checkPolicy(policy), /only the master release/);
  assert.throws(() => checkPolicy({ ...policy, after: snapshot("1.2.4-dev.42") }), /never be committed/);
  assert.throws(
    () => checkPolicy({ ...policy, after: (f) => (f === "Cargo.toml" ? after(f) : before(f)) }),
    /out of sync/,
  );
  checkPolicy({ ...policy, after: before });
});

test("only a master release workflow bumps, while other branches can sync master's version", () => {
  assert.throws(() => checkPolicy({ before, after, master, branch: "master" }), /only the master release/);
  checkPolicy({ before, after, master: before, branch: "master", releaseWorkflow: true });
  checkPolicy({ before, after, master, branch: "develop" });
  assert.throws(
    () => checkPolicy({ before: after, after: before, master, branch: "master", releaseWorkflow: true }),
    /increase/,
  );
  assert.throws(() => checkPolicy({ before, after, master: before, branch: "feature", releaseWorkflow: true }));
});

test("publication refuses a partial release and produces four updater targets from six signed artifacts", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "guild-release-test-"));
  const version = "1.2.4-dev.42";
  try {
    assert.throws(() => assemble(directory, version, "alice/guild", "a".repeat(40)));
    for (const platform of PLATFORMS)
      for (const file of filenames(version, platform)) {
        writeFileSync(path.join(directory, file), `artifact ${platform} ${file}`);
        writeFileSync(path.join(directory, `${file}.sig`), "signed-artifact");
      }
    const meta = assemble(directory, version, "alice/guild", "a".repeat(40));
    assert.equal(meta.artifacts.length, 6);
    const manifest = JSON.parse(readFileSync(path.join(directory, "latest.json")));
    assert.equal(Object.keys(manifest.platforms).length, 4);
    assert.ok(manifest.platforms["darwin-aarch64"].url.endsWith(".app.tar.gz"));
    assert.ok(meta.artifacts.every((a) => /^[a-f0-9]{64}$/.test(a.sha256)));
    writeFileSync(path.join(directory, `${filenames(version, "windows-x86_64")[0]}.sig`), "");
    assert.throws(() => assemble(directory, version, "alice/guild", "a".repeat(40)), /empty artifact or signature/);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("master version commits require the release key's signature and change only version files", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "guild-release-signature-test-"));
  const command = (program, args) => execFileSync(program, args, { cwd: directory, stdio: "pipe", encoding: "utf8" });
  try {
    command("git", ["init", "-q"]);
    command("git", ["config", "user.name", "alice"]);
    command("git", ["config", "user.email", "alice@example.test"]);
    writeFileSync(path.join(directory, "Cargo.toml"), "baseline");
    command("git", ["add", "Cargo.toml"]);
    command("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "baseline"]);
    command("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "release-test", "-f", "key"]);
    const publicKey = readFileSync(path.join(directory, "key.pub"), "utf8");
    writeFileSync(path.join(directory, "Cargo.toml"), "new version");
    command("git", ["add", "Cargo.toml"]);
    command("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "unsigned version"]);
    assert.equal(verifyReleaseCommit("HEAD", publicKey, directory), false);
    writeFileSync(path.join(directory, "Cargo.toml"), "signed version");
    command("git", ["add", "Cargo.toml"]);
    const signedCommit = [
      "-c",
      "gpg.format=ssh",
      "-c",
      `user.signingkey=${path.join(directory, "key")}`,
      "-c",
      "commit.gpgsign=true",
      "commit",
      "-qm",
    ];
    command("git", [...signedCommit, "release version"]);
    assert.equal(verifyReleaseCommit("HEAD", publicKey, directory), true);
    writeFileSync(path.join(directory, "unexpected.txt"), "outside release version files");
    command("git", ["add", "unexpected.txt"]);
    command("git", [...signedCommit, "unrelated change"]);
    assert.equal(verifyReleaseCommit("HEAD", publicKey, directory), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
