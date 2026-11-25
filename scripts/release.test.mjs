import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  assemble,
  checkPolicy,
  filenames,
  PLATFORMS,
  previewVersion,
  nextStableVersion,
  previewCleanup,
  releasePins,
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
    const meta = assemble(directory, version, "alice/guild", "a".repeat(40), "refs/heads/develop");
    assert.equal(meta.channel, "develop");
    assert.equal(meta.source_ref, "refs/heads/develop");
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

test("publication handles a fresh runner without Git identity and a draft missing from listings", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "guild-release-publish-test-"));
  const version = "1.2.4-dev.42";
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const globalConfig = path.join(directory, "empty-git-config");
  writeFileSync(globalConfig, "");
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) =>
    execFileSync(realGit, args, { cwd: directory, env: gitEnv, encoding: "utf8", stdio: "pipe" });
  git("init", "-q");
  writeFileSync(path.join(directory, "source.txt"), "release source");
  git("add", "source.txt");
  git(
    "-c",
    "user.name=alice",
    "-c",
    "user.email=alice@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "source",
  );
  const commit = git("rev-parse", "HEAD").trim();
  try {
    for (const platform of PLATFORMS)
      for (const file of filenames(version, platform)) {
        writeFileSync(path.join(directory, file), "artifact");
        writeFileSync(path.join(directory, `${file}.sig`), "signature");
      }
    assemble(directory, version, "alice/guild", commit);
    const fake = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const args = process.argv.slice(2), dir = process.env.RELEASE_TEST_DIR;
fs.appendFileSync(path.join(dir, 'calls'), JSON.stringify(args) + '\\n');
if (path.basename(process.argv[1]) === 'git') {
  if (args[0] !== 'ls-remote' && args[0] !== 'push') process.stdout.write(require('node:child_process').execFileSync(process.env.RELEASE_TEST_REAL_GIT, args, {cwd:dir,encoding:'utf8',stdio:'pipe'}));
} else if (args.includes('--slurp')) console.log('[[]]');
else if (args.includes('POST')) console.log('{"id":42,"draft":true}');
else if (args[0] === 'api' && args[1].endsWith('/releases/42')) {
  console.log(JSON.stringify({ assets: fs.readdirSync(dir).filter(n => /^(Guild|release\\.json|latest\\.json|SHA256SUMS)/.test(n)).map(name => {
    const bytes = fs.readFileSync(path.join(dir, name));
    return {name, size:bytes.length, digest:'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')};
  })}));
} else if (args[0] !== 'release') process.exit(1);
`;
    for (const program of ["git", "gh"]) writeFileSync(path.join(directory, program), fake, { mode: 0o755 });
    execFileSync(process.execPath, [new URL("./release.mjs", import.meta.url).pathname, "publish", directory], {
      env: {
        ...gitEnv,
        RELEASE_TEST_REAL_GIT: realGit,
        PATH: `${directory}:${process.env.PATH}`,
        RELEASE_TEST_DIR: directory,
        RELEASE_TEST_COMMIT: commit,
      },
      stdio: "pipe",
    });
    const calls = readFileSync(path.join(directory, "calls"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.filter((args) => args.includes("--slurp")).length, 1);
    assert.ok(calls.some((args) => args.includes("--draft=false")));
    assert.match(
      git("cat-file", "-p", "client-v1.2.4-dev.42"),
      /tagger Guild release automation <release@example.test>/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manual stable releases default to the next patch and validation trusts only master release events", () => {
  assert.equal(nextStableVersion("1.2.9"), "1.2.10");
  assert.equal(nextStableVersion("1.2.9007199254740993"), "1.2.9007199254740994");
  assert.throws(() => nextStableVersion("1.2.3-dev.42"));
  for (const event of ["push", "workflow_dispatch"]) {
    execFileSync(process.execPath, [new URL("./release.mjs", import.meta.url).pathname, "check-stable", baseline], {
      env: {
        ...process.env,
        GITHUB_WORKFLOW: "Release clients",
        GITHUB_REF: "refs/heads/master",
        GITHUB_EVENT_NAME: event,
      },
      stdio: "pipe",
    });
  }
  assert.throws(() =>
    execFileSync(process.execPath, [new URL("./release.mjs", import.meta.url).pathname, "check-stable", baseline], {
      env: {
        ...process.env,
        GITHUB_WORKFLOW: "Release clients",
        GITHUB_REF: "refs/heads/develop",
        GITHUB_EVENT_NAME: "push",
      },
      stdio: "pipe",
    }),
  );
});
test("master push uses the matching release PR title and validates a stable increase", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release-clients.yml", import.meta.url), "utf8");
  const start = workflow.indexOf('            if [ "$GITHUB_EVENT_NAME" = push ]; then');
  const end = workflow.indexOf('            git config user.name', start);
  assert(start >= 0 && end > start);
  const selection = workflow.slice(start, end);
  const commit = "a".repeat(40);
  const matching = {
    merged_at: "2026-01-01T00:00:00Z",
    merge_commit_sha: commit,
    base: { ref: "master", repo: { full_name: "alice/guild" } },
  };
  const target = `${Number(baseline.split(".")[0]) + 1}.0.0`;
  const select = (prs, head = commit) =>
    execFileSync("bash", ["-euo", "pipefail", "-c", [
      'git() { printf "%s\\n" "$MASTER_HEAD"; }',
      'gh() { printf "%s\\n" "$ASSOCIATED_PRS"; }',
      selection,
      'printf "%s\\n" "$RELEASE_VERSION"',
    ].join("\n")], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        GITHUB_WORKFLOW: "Release clients",
        GITHUB_REF: "refs/heads/master",
        GITHUB_EVENT_NAME: "push",
        GITHUB_SHA: commit,
        GITHUB_REPOSITORY: "alice/guild",
        MASTER_HEAD: head,
        ASSOCIATED_PRS: JSON.stringify(prs),
        RELEASE_VERSION: "",
      },
      encoding: "utf8",
      stdio: "pipe",
    }).trim();

  const valid = { ...matching, title: `Release ${target}` };
  assert.equal(select([[{ ...valid, merged_at: null }], [valid]]), target);
  assert.throws(() => select([[]]), /expected one merged master release PR/);
  assert.throws(() => select([[valid, valid]]), /expected one merged master release PR/);
  assert.throws(() => select([[valid]], "b".repeat(40)), /Master advanced/);
  assert.throws(() => select([[{ ...matching, title: "Release 9.0.0-dev.1" }]]), /Release X.Y.Z/);
  assert.throws(() => select([[{ ...matching, title: "Release 09.0.0" }]]), /semver triple/);
  assert.throws(() => select([[{ ...matching, title: `Release ${baseline}` }]]), /must be greater/);
  assert.throws(() => select([[{ ...matching, title: "Release 0.0.0" }]]), /must not decrease/);
});


test("develop cleanup keeps newest ten, anything under fourteen days, and installation pins", () => {
  const now = Date.UTC(2026, 10, 20);
  const release = (n, age, extra = {}) => ({
    id: n,
    tag_name: `client-v1.2.4-dev.${n}`,
    prerelease: true,
    draft: false,
    published_at: new Date(now - age * 86400_000).toISOString(),
    ...extra,
  });
  const releases = Array.from({ length: 15 }, (_, i) => release(i + 1, 20 + i));
  releases.push(release(100, 1));
  releases.push(release(101, 2, { tag_name: "client-v1.2.4", prerelease: false }));
  releases.push(release(102, 100, { tag_name: "unrelated", prerelease: true }));
  const pins = releasePins({ dev: "client-v1.2.4-dev.15" });
  const obsolete = previewCleanup(releases, pins, now).map((r) => r.id);
  assert.deepEqual(obsolete, [10, 11, 12, 13, 14]);
  assert.equal(releases.length, 18);
  const fresh = Array.from({ length: 30 }, (_, i) => release(i + 1, 1));
  assert.deepEqual(previewCleanup(fresh, [], now), []);
  assert.deepEqual(previewCleanup(releases.slice(0, 10), [], now), []);
  assert.throws(() => releasePins({ dev: "client-v1.2.4" }), /invalid release pin/);
  assert.throws(() => previewCleanup([release(1, 0, { published_at: "invalid" })], [], now), /invalid date/);
});

test("preview pruning defaults to a dry run and never deletes stable or pinned releases", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "guild-release-prune-test-"));
  const releases = Array.from({ length: 13 }, (_, i) => ({
    id: i + 1,
    tag_name: `client-v1.2.4-dev.${i + 1}`,
    prerelease: true,
    draft: false,
    published_at: new Date(Date.UTC(2020, 0, 30 - i)).toISOString(),
  }));
  releases.push({ id: 99, tag_name: "client-v1.2.4", prerelease: false, published_at: "2020-01-01T00:00:00Z" });
  try {
    writeFileSync(path.join(directory, "releases.json"), JSON.stringify(releases));
    writeFileSync(
      path.join(directory, "gh"),
      `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const dir=process.env.RELEASE_TEST_DIR,args=process.argv.slice(2),releases=JSON.parse(fs.readFileSync(path.join(dir,'releases.json')));
const body=args.includes('--input')?JSON.parse(fs.readFileSync(0,'utf8')):null;
fs.appendFileSync(path.join(dir,'calls'),JSON.stringify([...args,body])+'\\n');
if(args.includes('--slurp'))console.log(JSON.stringify([releases]));
else if(args.includes('DELETE')){}
else if(args[1].endsWith('/git/ref/heads/master'))console.log(JSON.stringify({object:{sha:'master'}}));
else if(args[1].endsWith('/git/tags') && args.includes('POST'))console.log(JSON.stringify({sha:'lock-object'}));
else if(args[1].endsWith('/git/refs') && args.includes('POST'))console.log('{}');
else if(args[1].endsWith('/git/ref/tags/guild-preview-retention-lock'))console.log(JSON.stringify({object:{sha:process.env.RELEASE_TEST_LOST_LOCK?'other-owner':'lock-object'}}));
else if(args[1].endsWith('/git/matching-refs/tags/guild-pin-'))console.log(JSON.stringify([{ref:'refs/tags/guild-pin-dev',object:{type:'tag',sha:'pin'}}]));
else if(args[1].includes('/releases/tags/'))console.log(JSON.stringify(releases[11]));
else if(args[1].includes('/git/ref/tags/client-v'))console.log(JSON.stringify({object:{type:'commit',sha:'source'}}));
else if(args[1].endsWith('/git/matching-refs/tags/guild-pin-dev'))console.log(JSON.stringify([{ref:'refs/tags/guild-pin-dev'},{ref:'refs/tags/guild-pin-dev-pending-11111111-1111-1111-1111-111111111111'}]));
else if(args[1].endsWith('/git/tags/pin'))console.log(JSON.stringify({message:JSON.stringify({release:'client-v1.2.4-dev.12'})}));
else {
 const release=releases.find(r=>args[1].endsWith('/releases/'+r.id));
 if(!release)process.exit(1);console.log(JSON.stringify(release));
}
`,
      { mode: 0o755 },
    );
    const options = {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "alice/guild",
        RELEASE_TEST_DIR: directory,
      },
      stdio: "pipe",
    };
    const command = [new URL("./release.mjs", import.meta.url).pathname, "prune"];
    execFileSync(process.execPath, command, options);
    assert.ok(!readFileSync(path.join(directory, "calls"), "utf8").includes("DELETE"));
    writeFileSync(path.join(directory, "calls"), "");
    execFileSync(process.execPath, [...command, "--apply"], options);
    const deletes = readFileSync(path.join(directory, "calls"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse)
      .filter((args) => args.includes("DELETE"));
    assert.deepEqual(
      deletes.map((args) => args[1]),
      [
        "repos/alice/guild/releases/11",
        "repos/alice/guild/git/refs/tags/client-v1.2.4-dev.11",
        "repos/alice/guild/releases/13",
        "repos/alice/guild/git/refs/tags/client-v1.2.4-dev.13",
        "repos/alice/guild/git/refs/tags/guild-preview-retention-lock",
      ],
    );
    writeFileSync(path.join(directory, "calls"), "");
    assert.throws(() =>
      execFileSync(process.execPath, [...command, "--apply"], {
        ...options,
        env: { ...options.env, RELEASE_TEST_LOST_LOCK: "1" },
      }),
    );
    assert.ok(!readFileSync(path.join(directory, "calls"), "utf8").includes("DELETE"));
    writeFileSync(path.join(directory, "calls"), "");
    execFileSync(process.execPath, [command[0], "pin", "dev", "client-v1.2.4-dev.12"], options);
    const pinCalls = readFileSync(path.join(directory, "calls"), "utf8").trim().split("\n").map(JSON.parse);
    const appended = pinCalls.findIndex(
      (args) => args.includes("POST") && args.at(-1)?.ref?.startsWith("refs/tags/guild-pin-dev-"),
    );
    const retired = pinCalls.findIndex(
      (args) => args.includes("DELETE") && args[1].endsWith("/git/refs/tags/guild-pin-dev"),
    );
    assert.ok(appended >= 0 && retired > appended);
    assert.ok(!pinCalls.some((args) => args.includes("DELETE") && args[1].includes("guild-pin-dev-pending")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the sync workflow signs and policy-checks its version PR before merging through Git", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "guild-release-sync-test-"));
  const runner = path.join(directory, "runner"),
    remote = path.join(directory, "remote.git"),
    bin = path.join(directory, "bin");
  const temporary = path.join(directory, "temp");
  for (const dir of [runner, bin, temporary]) mkdirSync(dir);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(directory, "gitconfig") };
  writeFileSync(env.GIT_CONFIG_GLOBAL, "");
  const git = (...args) => execFileSync("git", args, { cwd: runner, env, encoding: "utf8", stdio: "pipe" });
  try {
    git("init", "-q", "-b", "master");
    git("init", "-q", "--bare", remote);
    git("config", "user.name", "alice");
    git("config", "user.email", "alice@example.test");
    for (const file of files) {
      mkdirSync(path.dirname(path.join(runner, file)), { recursive: true });
      writeFileSync(path.join(runner, file), before(file));
    }
    mkdirSync(path.join(runner, "scripts"), { recursive: true });
    for (const name of ["release.mjs", "bump-version.sh"])
      writeFileSync(path.join(runner, "scripts", name), readFileSync(new URL(name, import.meta.url)));
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "baseline");
    git("branch", "develop");
    for (const file of files) writeFileSync(path.join(runner, file), after(file));
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "stable version");
    git("remote", "add", "origin", remote);
    git("push", "-q", "origin", "master", "develop");
    const key = path.join(directory, "key");
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "release-sync-test", "-f", key], { stdio: "pipe" });
    writeFileSync(
      path.join(bin, "gh"),
      `#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]==='pr' && args[1]==='create')console.log('https://github.com/alice/guild/pull/1');
else if(args[0]==='run' && args[1]==='list')console.log('success');
else if(!(args[0]==='pr' && args[1]==='list'))process.exit(1);
`,
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(bin, "cargo"),
      String.raw`#!${process.execPath}
const fs=require('node:fs');const version=fs.readFileSync('Cargo.toml','utf8').match(/^version = "([^"]+)"/m)[1];
const lock=fs.readFileSync('Cargo.lock','utf8').replace(/(name = "(?:protocol|guild-core|guild-app-server|guild-desktop)"\nversion = ")[^"]+("\n)/g,(_,a,b)=>a+version+b);fs.writeFileSync('Cargo.lock',lock);
`,
      { mode: 0o755 },
    );
    const workflow = readFileSync(new URL("../.github/workflows/release-clients.yml", import.meta.url), "utf8");
    const section = workflow.slice(workflow.indexOf("\n  sync-develop:"));
    const lines = section.split("        run: |\n")[1].split("\n");
    const body = [];
    for (const line of lines) {
      if (line.trim() && !line.startsWith("          ")) break;
      body.push(line.slice(10));
    }
    execFileSync("bash", ["-c", body.join("\n")], {
      cwd: runner,
      stdio: "pipe",
      env: {
        ...env,
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: temporary,
        RELEASE_PUSH_KEY: readFileSync(key, "utf8"),
        RELEASE_SIGNING_PUBLIC_KEY: readFileSync(`${key}.pub`, "utf8"),
        GITHUB_WORKFLOW: "Release clients",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/master",
      },
    });
    const updated = JSON.parse(git("--git-dir", remote, "show", "develop:apps/server/package.json"));
    assert.equal(updated.version, "1.2.4");
    const signed = git("--git-dir", remote, "rev-parse", "refs/heads/sync/client-version-1.2.4").trim();
    assert.equal(verifyReleaseCommit(signed, readFileSync(`${key}.pub`, "utf8"), runner), true);
    assert.equal(git("--git-dir", remote, "rev-list", "--parents", "-n", "1", "develop").trim().split(" ").length, 3);
    const priorDevelop = git("--git-dir", remote, "rev-parse", "develop").trim();
    git("switch", "master");
    writeFileSync(path.join(runner, "unexpected.txt"), "master-only source change");
    git("add", "unexpected.txt");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "master source");
    for (const file of files) writeFileSync(path.join(runner, file), snapshot("1.2.5")(file));
    git("add", ".");
    git("-c", `user.signingkey=${key}`, "-c", "commit.gpgsign=true", "commit", "-qm", "signed stable version");
    const unrelatedSource = git("rev-parse", "HEAD").trim();
    assert.equal(verifyReleaseCommit(unrelatedSource, readFileSync(`${key}.pub`, "utf8"), runner), true);
    git("push", "-q", "origin", "master", `${unrelatedSource}:refs/heads/sync/client-version-1.2.5`);
    assert.throws(() =>
      execFileSync("bash", ["-c", body.join("\n")], {
        cwd: runner,
        stdio: "pipe",
        env: {
          ...env,
          PATH: `${bin}:${process.env.PATH}`,
          RUNNER_TEMP: temporary,
          RELEASE_PUSH_KEY: readFileSync(key, "utf8"),
          RELEASE_SIGNING_PUBLIC_KEY: readFileSync(`${key}.pub`, "utf8"),
          GITHUB_WORKFLOW: "Release clients",
          GITHUB_EVENT_NAME: "push",
          GITHUB_REF: "refs/heads/master",
        },
      }),
    );
    assert.equal(git("--git-dir", remote, "rev-parse", "develop").trim(), priorDevelop);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
