#!/usr/bin/env node
// Release policy, isolated preview builds, and complete GitHub publications.
// Run with --help for the local and CI entry points.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

export function previewVersion(stable, build) {
  assert(STABLE.test(stable), "the committed product version must be stable");
  assert(/^[1-9]\d*$/.test(String(build)), "build number must be a positive integer");
  const [major, minor, patch] = stable.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}-dev.${build}`;
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
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
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

function configure() {
  const repository = JSON.parse(run("gh", ["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
  const api = (route, method = "GET", body, allowMissing = false) => {
    let result;
    try {
      result = run(
        "gh",
        ["api", `repos/${repository}/${route}`, "--method", method, ...(body ? ["--input", "-"] : [])],
        { stdio: ["pipe", "pipe", "pipe"], ...(body ? { input: JSON.stringify(body) } : {}) },
      );
    } catch (error) {
      if (allowMissing && String(error.stdout).includes('"status":"404"')) return null;
      throw error;
    }
    return result.trim() ? JSON.parse(result) : null;
  };
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
  console.log("Required version checks, master-only release credentials and immutable releases configured");
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

function deployPreview(directory) {
  const meta = json(path.join(path.resolve(directory), "release.json"));
  assert(
    PREVIEW.test(meta.version) && meta.commit === git("rev-parse", "HEAD"),
    "deploy the preview built from this committed checkout",
  );
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
      console.log(versions((f) => readFileSync(path.join(ROOT, f), "utf8")));
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
      deployPreview(args[0]);
      return;
    default:
      console.log(
        "Usage: node scripts/release.mjs configure | version | preview [build-number] | deploy-preview <directory> | publish <directory> | collect <input> <output> <version> | assemble <directory> <version> <repository> <commit> | check-policy <base> <head> <master> <branch>\nPUBLISH=1 publishes a local preview. Stable publication runs only in the master Release clients workflow.",
      );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
