#!/usr/bin/env python3
"""Fail on a personal identifier in a tracked file.

The repository is published, so a real person, machine or company is written
as a placeholder: `example.com`, `alice`, `WORKSTATION`, `/home/user`. A real
value belongs in the deployment configuration on the host, never in a commit.

Two rules:

  1. A listed literal (below) must not appear.
  2. An email address must use a documentation domain: example.com,
     example.org, example.net, *.test, *.invalid, or an allowlisted service
     account domain.

Usage: scripts/check-identifiers.py [path ...]
Exit: 0 clean, 1 findings.
"""

from __future__ import annotations

import re
import subprocess
import sys

# Literals that name a real person, machine or company.
LITERALS = [
    "ematvey",
    "ematv",
    "matvey",
    "citadel",
    "funbox",
    "diagnocat",
    "d.timonin",
    "timonin",
]

# Domains an example address may use.
EMAIL_DOMAINS_OK = (
    "example.com",
    "example.org",
    "example.net",
    "example.test",
    "test",
    "invalid",
    "localhost",
    "host.docker.internal",
    "iam.gserviceaccount.com",
    "googleapis.com",
    "users.noreply.github.com",
)

EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})")

# The list above names the identifiers; this file is the one place they live.
SKIP = {"scripts/check-identifiers.py"}

BINARY_SUFFIXES = (
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".woff",
    ".woff2", ".ttf", ".otf", ".pdf", ".zip", ".gz", ".so", ".dylib",
    ".dll", ".exe", ".node", ".bin", ".wasm", ".guildplugin",
)


def tracked(paths: list[str]) -> list[str]:
    if paths:
        return paths
    out = subprocess.run(
        ["git", "ls-files", "-z"], capture_output=True, check=True
    ).stdout
    return [p for p in out.decode().split("\0") if p]


def scan(path: str):
    if path in SKIP or path.endswith(BINARY_SUFFIXES):
        return
    try:
        data = open(path, "rb").read()
    except OSError:
        return
    if b"\0" in data[:4000]:
        return
    text = data.decode("utf-8", errors="replace")
    for lineno, line in enumerate(text.splitlines(), 1):
        lowered = line.lower()
        for literal in LITERALS:
            if literal in lowered:
                yield lineno, f"personal identifier {literal!r}", line.strip()
        for match in EMAIL.finditer(line):
            domain = match.group(1).lower()
            if not any(domain == d or domain.endswith("." + d) for d in EMAIL_DOMAINS_OK):
                yield lineno, f"real email domain {domain!r}", line.strip()


def main(argv: list[str]) -> int:
    findings = 0
    for path in tracked(argv[1:]):
        for lineno, reason, line in scan(path):
            print(f"{path}:{lineno}: {reason}")
            print(f"    {line[:160]}")
            findings += 1
    if findings:
        print(f"\n{findings} personal identifier(s). Use a placeholder.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
