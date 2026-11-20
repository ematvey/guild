#!/usr/bin/env node
// Release policy, isolated preview builds, and complete GitHub publications.
// Run with --help for the local and CI entry points.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PREVIEW = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev\.([1-9]\d*)$/;
const MEMBERS = ["apps/desktop", "apps/server", "packages/ui"];
const PRODUCT_FILES = [
  "Cargo.toml",
  "Cargo.lock",
  "apps/desktop/src-tauri/tauri.conf.json",
  ...MEMBERS.map((m) => `${m}/package.json`),
  "package-lock.json",
];
export const PLATFORMS = ["windows-x86_64", "linux-x86_64", "darwin-aarch64", "darwin-x86_64"];
const run = (file, args, options = {}) => execFileSync(file, args, { cwd: ROOT, encoding: "utf8", ...options });
const git = (...args) => run("git", args).trim();
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const save = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

export function versions(read) {
  const cargo = read("Cargo.toml").match(/\[workspace.package\][\s\S]*?^version = "([^"]+)"/m)?.[1];
  const values = [cargo, JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")).version];
  for (const member of MEMBERS) values.push(JSON.parse(read(`${member}/package.json`)).version);
  const lock = JSON.parse(read("package-lock.json"));
  for (const member of MEMBERS) values.push(lock.packages[member].version);
  const packages = read("Cargo.lock").split("[[package]]").slice(1);
  for (const name of ["guild-app-server", "guild-core", "guild-desktop", "protocol"]) {
    values.push(packages.find((p) => p.includes(`name = "${name}"\n`))?.match(/^version = "([^"]+)"/m)?.[1]);
  }
  assert(values.every((v) => v === cargo) && typeof cargo === "string", "product versions are out of sync");
  return cargo;
}

export function nextStableVersion(stable) {
  assert(STABLE.test(stable), "the committed product version must be stable");
  const [major, minor, patch] = stable.split(".").map(BigInt);
  return `${major}.${minor}.${patch + 1n}`;
}

export function previewVersion(stable, build) {
  assert(STABLE.test(stable), "the committed product version must be stable");
  assert(/^[1-9]\d*$/.test(String(build)), "build number must be a positive integer");
  return `${nextStableVersion(stable)}-dev.${build}`;
}

// Checks semantic version fields, allowing unrelated dependency lock changes.
// Syncing a master release back into another branch keeps that master's version.
export function checkPolicy({ before, after, master, branch, releaseWorkflow = false }) {
  const old = versions(before);
  const current = versions(after);
  assert(STABLE.test(current), "preview stamps must never be committed");
  if (current === old) return;
  if (releaseWorkflow && branch === "master") {
    assert(
      current
        .split(".")
        .map(BigInt)
        .some(
          (n, i, a) => n > BigInt(old.split(".")[i]) && a.slice(0, i).every((v, j) => v === BigInt(old.split(".")[j])),
        ),
      "a stable release must increase the version",
    );
    return;
  }
  assert(
    branch !== "master" && current === versions(master),
    "only the master release workflow may change the product version; other branches may sync master's version",
  );
}

export function filenames(version, platform) {
  if (platform === "windows-x86_64") return [`Guild_${version}_x64-setup.exe`];
  if (platform === "linux-x86_64") return [`Guild-${version}-x86_64.AppImage`];
  const arch = platform.slice("darwin-".length);
  return [`Guild-${version}-macos-${arch}.dmg`, `Guild-${version}-macos-${arch}.app.tar.gz`];
}

export function assemble(directory, version, repository, commit, sourceRef = "HEAD") {
  assert(STABLE.test(version) || PREVIEW.test(version), "invalid release version");
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository), "set GITHUB_REPOSITORY to owner/repository");
  assert(/^[a-f0-9]{40}$/.test(commit), "release provenance requires a committed source revision");
  const tag = `client-v${version}`;
  const base = `https://github.com/${repository}/releases/download/${tag}`;
  const artifacts = [];
  const platforms = {};
  for (const platform of PLATFORMS) {
    for (const filename of filenames(version, platform)) {
      const bytes = readFileSync(path.join(directory, filename));
      const signature = readFileSync(path.join(directory, `${filename}.sig`), "utf8").trim();
      assert(bytes.length > 0 && signature.length > 0, `empty artifact or signature: ${filename}`);
      const artifact = {
        platform,
        filename,
        size_bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        updater_signature: signature,
      };
      artifacts.push(artifact);
      if (!filename.endsWith(".dmg")) platforms[platform] = { signature, url: `${base}/${filename}` };
    }
  }
  const metadata = {
    version,
    tag,
    repository,
    commit,
    source_ref: sourceRef,
    channel: PREVIEW.test(version) ? "develop" : "stable",
    artifacts,
  };
  save(path.join(directory, "release.json"), metadata);
  save(path.join(directory, "latest.json"), {
    version,
    pub_date: new Date().toISOString(),
    notes: `Guild ${version}`,
    platforms,
  });
  writeFileSync(path.join(directory, "SHA256SUMS"), artifacts.map((a) => `${a.sha256}  ${a.filename}\n`).join(""));
  return metadata;
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

// Native CI bundles and the local cross-builds enter the same publication shape.
function collect(input, output, version) {
  mkdirSync(output, { recursive: true });
  for (const platform of PLATFORMS) {
    const files = walk(path.join(input, platform));
    for (const name of filenames(version, platform)) {
      const suffix = name.endsWith(".app.tar.gz") ? ".app.tar.gz" : path.extname(name);
      const matches = files.filter((f) => f.endsWith(suffix));
      assert(matches.length === 1, `${platform}: expected one ${suffix}, found ${matches.length}`);
      writeFileSync(path.join(output, name), readFileSync(matches[0]));
      writeFileSync(path.join(output, `${name}.sig`), readFileSync(`${matches[0]}.sig`));
    }
  }
}

function trustedStableWorkflow() {
  return (
    process.env.GITHUB_WORKFLOW === "Release clients" &&
    ["workflow_dispatch", "push"].includes(process.env.GITHUB_EVENT_NAME) &&
    process.env.GITHUB_REF === "refs/heads/master"
  );
}

// The master push from the release deploy key triggers CI too. Verify its
// signature rather than trusting an author name or commit-message marker.
export function verifyReleaseCommit(commit, publicKey, cwd = ROOT) {
  if (!publicKey?.startsWith("ssh-ed25519 ")) return false;
  const directory = mkdtempSync(path.join(tmpdir(), "guild-release-signers-"));
  try {
    const changed = run("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", commit], { cwd })
      .trim()
      .split("\n");
    if (!changed.length || changed.some((f) => !PRODUCT_FILES.includes(f))) return false;
    const allowed = path.join(directory, "allowed-signers");
    writeFileSync(allowed, `release ${publicKey.trim()}\n`);
    run("git", ["-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${allowed}`, "verify-commit", commit], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function githubApi(repository, route, method = "GET", body, allowMissing = false) {
  let result;
  try {
    result = run(
      "gh",
      ["api", `repos/${repository}${route ? `/${route}` : ""}`, "--method", method, ...(body ? ["--input", "-"] : [])],
      { stdio: ["pipe", "pipe", "pipe"], ...(body ? { input: JSON.stringify(body) } : {}) },
    );
  } catch (error) {
    if (allowMissing && String(error.stdout).includes('"status":"404"')) return null;
    throw error;
  }
  return result.trim() ? JSON.parse(result) : null;
}

function configure() {
  const repository = JSON.parse(run("gh", ["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
  const api = (...args) => githubApi(repository, ...args);
  const classic = api("branches/master/protection", "GET", undefined, true);
  if (classic) {
    const reviews = classic.required_pull_request_reviews;
    assert(
      !classic.required_status_checks &&
        !classic.restrictions &&
        !reviews?.required_approving_review_count &&
        !reviews?.dismiss_stale_reviews &&
        !reviews?.require_code_owner_reviews &&
        !reviews?.require_last_push_approval &&
        ["required_signatures", "required_linear_history", "required_conversation_resolution", "lock_branch"].every(
          (k) => !classic[k]?.enabled,
        ),
      "map customized master protections into the release rulesets before configuring automation",
    );
  }
  api("environments/stable-release", "PUT", {
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  });
  const policies = api("environments/stable-release/deployment-branch-policies").branch_policies;
  for (const policy of policies)
    if (policy.name !== "master" || policy.type !== "branch")
      api(`environments/stable-release/deployment-branch-policies/${policy.id}`, "DELETE");
  if (!policies.some((p) => p.name === "master" && p.type === "branch"))
    api("environments/stable-release/deployment-branch-policies", "POST", { name: "master", type: "branch" });
  let key = api("keys").find((k) => k.title === "Guild master releases");
  if (!key) {
    const directory = mkdtempSync(path.join(tmpdir(), "guild-release-key-"));
    try {
      const file = path.join(directory, "key");
      run("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "guild-release", "-f", file], { stdio: "ignore" });
      key = api("keys", "POST", {
        title: "Guild master releases",
        key: readFileSync(`${file}.pub`, "utf8").trim(),
        read_only: false,
      });
      run("gh", ["secret", "set", "RELEASE_PUSH_KEY", "--env", "stable-release", "--repo", repository], {
        input: readFileSync(file),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  } else {
    const secrets = JSON.parse(
      run("gh", ["secret", "list", "--env", "stable-release", "--repo", repository, "--json", "name"]),
    );
    assert(
      secrets.some((s) => s.name === "RELEASE_PUSH_KEY"),
      "restore the stable-release RELEASE_PUSH_KEY secret for the existing deploy key",
    );
  }
  assert(key.read_only === false, "the release deploy key must permit pushes");
  run("gh", ["variable", "set", "RELEASE_SIGNING_PUBLIC_KEY", "--repo", repository, "--body", key.key]);
  for (const file of ["release-ruleset.json", "master-release-ruleset.json"]) {
    const ruleset = json(path.join(ROOT, ".github", file));
    ruleset.bypass_actors = [{ actor_id: key.id, actor_type: "DeployKey", bypass_mode: "always" }];
    const existing = api("rulesets").find((r) => r.name === ruleset.name);
    api(`rulesets${existing ? `/${existing.id}` : ""}`, existing ? "PUT" : "POST", ruleset);
  }
  if (classic) api("branches/master/protection", "DELETE");
  api("immutable-releases", "PUT");
  api("actions/permissions/workflow", "PUT", {
    default_workflow_permissions: "read",
    can_approve_pull_request_reviews: true,
  });
  console.log(
    "Required version checks, master-only release credentials, sync PR creation and immutable releases configured",
  );
}

async function publishGithub(directory) {
  const meta = json(path.join(directory, "release.json"));
  assert(
    !STABLE.test(meta.version) || trustedStableWorkflow(),
    "stable publication is restricted to the master release workflow",
  );
  if (STABLE.test(meta.version)) {
    assert(
      meta.version === versions((f) => readFileSync(path.join(ROOT, f), "utf8")),
      "stable artifacts must match the committed product version",
    );
  }
  assert(meta.commit === git("rev-parse", "HEAD"), "release source must be HEAD");
  const expected = assemble(directory, meta.version, meta.repository, meta.commit, meta.source_ref);
  assert(JSON.stringify(expected) === JSON.stringify(meta), "release metadata does not match its assets");
  // GitHub's by-tag endpoint omits drafts; list releases to resume them.
  const findRelease = () =>
    JSON.parse(run("gh", ["api", "--paginate", "--slurp", `repos/${meta.repository}/releases?per_page=100`]))
      .flat()
      .find((r) => r.tag_name === meta.tag);
  let release = findRelease();
  assert(!release || release.draft, "published releases are immutable; use a new build number");
  const tagCommit = run("git", ["ls-remote", "origin", `refs/tags/${meta.tag}`, `refs/tags/${meta.tag}^{}`])
    .trim()
    .split("\n")
    .filter(Boolean);
  if (tagCommit.length)
    assert(tagCommit.at(-1).split(/\s/)[0] === meta.commit, "tag already names another source commit");
  else {
    let localCommit;
    try {
      localCommit = git("rev-parse", "--quiet", "--verify", `refs/tags/${meta.tag}^{commit}`);
    } catch {
      /* New local tag. */
    }
    if (localCommit) assert(localCommit === meta.commit, "local tag already names another source commit");
    else run("git", ["tag", "-a", meta.tag, "-m", `client release ${meta.version}`, meta.commit]);
    run("git", ["push", "origin", `refs/tags/${meta.tag}`], { stdio: "inherit" });
  }
  if (!release) {
    // The creation response owns the ID: a newly created draft may not yet
    // appear in GitHub's release listing.
    release = JSON.parse(
      run("gh", [
        "api",
        "--method",
        "POST",
        `repos/${meta.repository}/releases`,
        "-f",
        `tag_name=${meta.tag}`,
        "-f",
        `name=Guild ${meta.version}`,
        "-f",
        `body=Guild ${meta.version}. Source revision: ${meta.commit}.`,
        "-F",
        "draft=true",
        "-F",
        `prerelease=${PREVIEW.test(meta.version)}`,
      ]),
    );
  }
  assert(release?.id, "GitHub did not return the release ID");
  const files = [
    ...meta.artifacts.flatMap((a) => [a.filename, `${a.filename}.sig`]),
    "release.json",
    "latest.json",
    "SHA256SUMS",
  ];
  run(
    "gh",
    [
      "release",
      "upload",
      meta.tag,
      "--repo",
      meta.repository,
      "--clobber",
      ...files.map((f) => path.join(directory, f)),
    ],
    { stdio: "inherit" },
  );
  const uploaded = JSON.parse(run("gh", ["api", `repos/${meta.repository}/releases/${release.id}`]));
  for (const name of files) {
    const bytes = readFileSync(path.join(directory, name));
    const asset = uploaded.assets.find((a) => a.name === name);
    assert(
      asset?.size === bytes.length && asset.digest === `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      `GitHub checksum mismatch: ${name}`,
    );
  }
  run(
    "gh",
    ["release", "edit", meta.tag, "--repo", meta.repository, "--draft=false", `--latest=${STABLE.test(meta.version)}`],
    { stdio: "inherit" },
  );
}

function preview(build) {
  const current = versions((f) => readFileSync(path.join(ROOT, f), "utf8"));
  const version = previewVersion(current, build ?? Date.now());
  assert(
    git("status", "--porcelain") === "",
    "commit changes before building a preview; the version stamp is temporary",
  );
  const source = git("rev-parse", "HEAD");
  const sourceRef = git("rev-parse", "--symbolic-full-name", "HEAD");
  const repository =
    process.env.GITHUB_REPOSITORY ?? JSON.parse(run("gh", ["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
  const directory = mkdtempSync(path.join(tmpdir(), "guild-preview-"));
  const checkout = path.join(directory, "source");
  const output = path.resolve(process.env.OUTPUT_DIR ?? path.join(tmpdir(), "guild-releases", version));
  try {
    run("git", ["worktree", "add", "--detach", checkout, source], { stdio: "inherit" });
    for (const name of ["target"])
      if (existsSync(path.join(ROOT, name)))
        symlinkSync(realpathSync(path.join(ROOT, name)), path.join(checkout, name), "dir");
    run("npm", ["ci"], { cwd: checkout, stdio: "inherit" });
    run("bash", ["scripts/bump-version.sh", "--build", version], { cwd: checkout, stdio: "inherit" });
    run("bash", ["scripts/release-clients.sh"], {
      cwd: checkout,
      stdio: "inherit",
      env: {
        ...process.env,
        GUILD_RELEASE_STAGED: "1",
        VERSION: version,
        OUTPUT_DIR: output,
        GITHUB_REPOSITORY: repository,
        RELEASE_SOURCE_COMMIT: source,
        RELEASE_SOURCE_REF: sourceRef,
      },
    });
  } finally {
    run("git", ["worktree", "remove", "--force", checkout]);
    rmSync(directory, { recursive: true, force: true });
  }
  console.log(`Preview ${version}: ${output}`);
  if (process.env.PUBLISH === "1") return publishGithub(output);
}

const PIN_PREFIX = "refs/tags/guild-pin-";
const RETENTION_LOCK = "tags/guild-preview-retention-lock";

export function releasePins(pins) {
  return Object.entries(pins).map(([name, tag]) => {
    assert(
      typeof tag === "string" && tag.startsWith("client-v") && PREVIEW.test(tag.slice(8)),
      `invalid release pin: ${name}`,
    );
    return tag;
  });
}

function readPins(repository) {
  const refs = githubApi(repository, "git/matching-refs/tags/guild-pin-");
  return releasePins(
    Object.fromEntries(
      refs.map((ref) => {
        assert(ref.ref.startsWith(PIN_PREFIX) && ref.object.type === "tag", "invalid installation pin ref");
        const annotation = githubApi(repository, `git/tags/${ref.object.sha}`);
        return [ref.ref, JSON.parse(annotation.message).release];
      }),
    ),
  );
}

async function withRetentionLock(repository, operation) {
  const master = githubApi(repository, "git/ref/heads/master").object.sha;
  const lock = githubApi(repository, "git/tags", "POST", {
    tag: "guild-preview-retention-lock",
    object: master,
    type: "commit",
    message: JSON.stringify({
      owner: randomUUID(),
      run: process.env.GITHUB_RUN_ID ?? "local",
      started_at: new Date().toISOString(),
    }),
  });
  let acquired = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      githubApi(repository, "git/refs", "POST", { ref: `refs/${RETENTION_LOCK}`, sha: lock.sha });
      acquired = true;
      break;
    } catch (error) {
      if (!String(error.stdout).includes("Reference already exists")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  assert(acquired, "release retention is locked; inspect the lock tag before retrying");
  const assertLock = () =>
    assert(
      githubApi(repository, `git/ref/${RETENTION_LOCK}`).object.sha === lock.sha,
      "release retention lock ownership changed",
    );
  try {
    return await operation(assertLock);
  } finally {
    assertLock();
    githubApi(repository, `git/refs/${RETENTION_LOCK}`, "DELETE");
  }
}

export function previewCleanup(releases, pins = [], now = Date.now()) {
  assert(Number.isFinite(now), "invalid cleanup time");
  const previews = releases
    .filter((r) => r.prerelease === true && r.tag_name?.startsWith("client-v") && PREVIEW.test(r.tag_name.slice(8)))
    .map((release) => ({ release, time: Date.parse(release.published_at ?? release.created_at) }))
    .sort((a, b) => b.time - a.time);
  assert(
    previews.every((r) => Number.isFinite(r.time)),
    "preview release has an invalid date; refusing cleanup",
  );
  return previews
    .filter(
      ({ release, time }, index) => index >= 10 && now - time >= 14 * 86400_000 && !pins.includes(release.tag_name),
    )
    .map(({ release }) => release);
}

function repositoryName() {
  return (
    process.env.GITHUB_REPOSITORY ?? JSON.parse(run("gh", ["repo", "view", "--json", "nameWithOwner"])).nameWithOwner
  );
}

function pinName(installation, pending = false) {
  assert(
    /^[a-zA-Z0-9_]{1,40}$/.test(installation),
    "installation pin name must contain letters, numbers or underscores",
  );
  return `guild-pin-${installation.toLowerCase()}${pending ? "-pending" : ""}`;
}

async function pinRelease(repository, installation, tag, pending = false) {
  const name = pinName(installation, pending);
  releasePins({ [name]: tag });
  await withRetentionLock(repository, (assertLock) => {
    const release = githubApi(repository, `releases/tags/${tag}`);
    assert(release.prerelease === true && release.draft === false, "pin a published develop release");
    let object = githubApi(repository, `git/ref/tags/${tag}`).object;
    for (let depth = 0; object.type === "tag" && depth < 10; depth++)
      object = githubApi(repository, `git/tags/${object.sha}`).object;
    assert(object.type === "commit", "release tag must resolve to a commit");
    const annotation = githubApi(repository, "git/tags", "POST", {
      tag: name,
      object: object.sha,
      type: "commit",
      message: JSON.stringify({ release: tag }),
    });
    const existing = githubApi(repository, `git/ref/tags/${name}`, "GET", undefined, true);
    assertLock();
    if (existing) githubApi(repository, `git/refs/tags/${name}`, "PATCH", { sha: annotation.sha, force: true });
    else githubApi(repository, "git/refs", "POST", { ref: `refs/tags/${name}`, sha: annotation.sha });
  });
  console.log(`Pinned ${tag} for ${installation}${pending ? " (pending deployment)" : ""}`);
}

async function unpinRelease(repository, installation, pending = false) {
  const name = pinName(installation, pending);
  await withRetentionLock(repository, (assertLock) => {
    assertLock();
    githubApi(repository, `git/refs/tags/${name}`, "DELETE", undefined, true);
  });
}

async function prunePreviews(apply) {
  const repository = repositoryName();
  const prune = (assertLock = () => {}) => {
    const pins = readPins(repository);
    const releases = JSON.parse(
      run("gh", ["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`]),
    ).flat();
    const obsolete = previewCleanup(releases, pins);
    console.log(
      JSON.stringify({ apply, keepNewest: 10, keepDays: 14, pins, delete: obsolete.map((r) => r.tag_name) }, null, 2),
    );
    if (!apply) return;
    for (const release of obsolete) {
      const current = githubApi(repository, `releases/${release.id}`);
      assert(current.prerelease === true && current.tag_name === release.tag_name, "release changed during cleanup");
      assertLock();
      githubApi(repository, `releases/${release.id}`, "DELETE");
      githubApi(repository, `git/refs/tags/${release.tag_name}`, "DELETE", undefined, true);
    }
  };
  if (apply) await withRetentionLock(repository, prune);
  else prune();
}

async function deployPreview(directory, installation = "dev") {
  const meta = json(path.join(path.resolve(directory), "release.json"));
  assert(
    PREVIEW.test(meta.version) && meta.commit === git("rev-parse", "HEAD"),
    "deploy the preview built from this committed checkout",
  );
  await pinRelease(meta.repository, installation, meta.tag, true);
  const compose = path.join(ROOT, "deploy/compose");
  const envFile = path.join(compose, ".env");
  const contents = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  writeFileSync(
    envFile,
    `${contents
      .split("\n")
      .filter((line) => !line.startsWith("GUILD_BUILD_VERSION="))
      .join("\n")
      .trimEnd()}\nGUILD_BUILD_VERSION=${meta.version}\n`,
  );
  run("docker", ["compose", "build", "server"], { cwd: compose, stdio: "inherit" });
  run("docker", ["compose", "up", "-d", "server"], { cwd: compose, stdio: "inherit" });
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      run(
        "docker",
        [
          "compose",
          "exec",
          "-T",
          "server",
          "node",
          "-e",
          'fetch("http://127.0.0.1:8080/api/v1/health").then(r=>r.json()).then(h=>{if(h.version!==process.argv[1])process.exit(1)}).catch(()=>process.exit(1))',
          meta.version,
        ],
        { cwd: compose, stdio: "pipe" },
      );
      await pinRelease(meta.repository, installation, meta.tag);
      await unpinRelease(meta.repository, installation, true);
      return;
    } catch (error) {
      if (attempt === 59) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "check-policy": {
      const [base, head, master, branch] = args;
      const read = (ref) => (file) => run("git", ["show", `${ref}:${file}`]);
      checkPolicy({
        before: read(base),
        after: read(head),
        master: read(master),
        branch,
        releaseWorkflow:
          trustedStableWorkflow() ||
          (branch === "master" &&
            process.env.GITHUB_EVENT_NAME === "push" &&
            verifyReleaseCommit(head, process.env.RELEASE_SIGNING_PUBLIC_KEY)),
      });
      console.log("Version policy passed");
      return;
    }
    case "version":
      console.log(
        versions((f) => (args[0] ? run("git", ["show", `${args[0]}:${f}`]) : readFileSync(path.join(ROOT, f), "utf8"))),
      );
      return;
    case "next-version":
      console.log(nextStableVersion(versions((f) => readFileSync(path.join(ROOT, f), "utf8"))));
      return;
    case "is-release-commit":
      process.exitCode = verifyReleaseCommit(args[0] ?? "HEAD", process.env.RELEASE_SIGNING_PUBLIC_KEY) ? 0 : 1;
      return;
    case "pin":
      await pinRelease(repositoryName(), args[0], args[1]);
      return;
    case "unpin":
      await unpinRelease(repositoryName(), args[0], args.includes("--pending"));
      return;
    case "prune":
      await prunePreviews(args.includes("--apply"));
      return;
    case "preview-version":
      console.log(
        previewVersion(
          versions((f) => readFileSync(path.join(ROOT, f), "utf8")),
          args[0],
        ),
      );
      return;
    case "check-stable": {
      assert(trustedStableWorkflow(), "stable preparation runs only in the master release workflow");
      const current = versions((f) => readFileSync(path.join(ROOT, f), "utf8"));
      assert(STABLE.test(args[0]), "stable release requires a semver triple");
      const a = args[0].split(".").map(BigInt),
        b = current.split(".").map(BigInt);
      assert(
        a.every((v, i) => v === b[i]) || a.some((v, i) => v > b[i] && a.slice(0, i).every((n, j) => n === b[j])),
        "release version must not decrease",
      );
      return;
    }
    case "preview":
      await preview(args[0]);
      return;
    case "collect":
      collect(args[0], args[1], args[2]);
      return;
    case "assemble":
      assemble(...args);
      return;
    case "publish":
      await publishGithub(path.resolve(args[0]));
      return;
    case "configure":
      configure();
      return;
    case "deploy-preview":
      await deployPreview(args[0], args[1]);
      return;
    default:
      console.log(
        "Usage: node scripts/release.mjs configure | version | preview [build-number] | deploy-preview <directory> [installation] | pin <installation> <tag> | unpin <installation> [--pending] | prune [--apply] | publish <directory> | collect <input> <output> <version> | assemble <directory> <version> <repository> <commit> | check-policy <base> <head> <master> <branch>\nPUBLISH=1 publishes a local preview. Stable publication runs only in the master Release clients workflow.",
      );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
