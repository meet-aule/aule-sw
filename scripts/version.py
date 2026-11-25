#!/usr/bin/env python3
"""The version of aule-sw: its copies, its changelog and its releases.

version.txt holds the version. The files listed below copy it, and only this
script writes them; RELEASING.md says how a release goes. Python 3 standard
library only.

    python3 scripts/version.py current          print the version
    python3 scripts/version.py check            exit 1 unless every copy and CHANGELOG.md agree
    python3 scripts/version.py set X.Y.Z        write X.Y.Z in every copy, lockfiles included
    python3 scripts/version.py next             the next version, from commits since the last tag
    python3 scripts/version.py notes [X.Y.Z]    the changelog section of those commits, headed
                                                X.Y.Z (by default, the next version)
    python3 scripts/version.py section [X.Y.Z]  X.Y.Z's section of CHANGELOG.md, heading and all
                                                (by default, the current version's): the body
                                                of its GitHub Release
    python3 scripts/version.py release [X.Y.Z] [--push]
        on an up-to-date main: branch release/X.Y.Z, set the version, put its
        section at the top of CHANGELOG.md and commit "chore(release): X.Y.Z".
        With --push, also push the branch and open its pull request with gh.
        It never tags: CI tags the version once that pull request is merged.

Before 1.0, a breaking change bumps the minor and anything else the patch;
1.0.0 is only ever given by hand.
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPOSITORY = "https://github.com/meet-aule/aule-sw"
SOURCE = "version.txt"
CHANGELOG = "CHANGELOG.md"
MARKER = "x-aule-version"

# The copies of the version. In a file that takes comments, the copy is the
# one line that ends with MARKER.
MARKED = (
    "apps/platform/Cargo.toml",
    "engine/Cargo.toml",
    "apps/agent/pyproject.toml",
    "apps/agent/src/aule_agent/_version.py",
)
# JSON takes no comments, so these are listed instead: their top-level "version".
JSON_COPIES = (
    "apps/admin/package.json",
    "apps/playground/package.json",
    "contracts/package.json",
    "curriculum/package.json",
)
# This repository's own packages in each lockfile. Nothing else in them is
# touched: another package may well have the same version number.
LOCKED = {
    "apps/platform/Cargo.lock": ("aule-platform", "aule-core", "contenido"),
    "engine/Cargo.lock": ("aule-core", "contenido"),
    "apps/agent/uv.lock": ("aule-agent",),
}

# The changelog's sections, in order, and the commit types each one lists.
SECTIONS = (
    ("Features", ("feat",)),
    ("Bug Fixes", ("fix",)),
    ("Performance", ("perf",)),
    ("Reverts", ("revert",)),
    ("Documentation", ("docs",)),
    ("Chores", ("chore", "refactor", "build", "ci", "test", "style")),
)
BREAKING = "⚠ BREAKING CHANGES"
TYPES = {kind for _, kinds in SECTIONS for kind in kinds}

NUMBER = r"(?:0|[1-9][0-9]*)"
SEMVER = rf"{NUMBER}\.{NUMBER}\.{NUMBER}"
MARKED_LINE = re.compile(
    rf'^(?P<before>[^\n"]*")(?P<version>[^"\n]*)(?P<after>"[^\n]*{MARKER}[^\n]*)$', re.M
)
JSON_LINE = re.compile(r'^(?P<before>  "version": ")(?P<version>[^"\n]*)(?P<after>")', re.M)
LOCK_ENTRY = re.compile(
    r'^\[\[package\]\]\nname = "(?P<name>[^"\n]+)"\nversion = "(?P<version>[^"\n]+)"\n'
    r"(?P<next>[^\n]*)$",
    re.M,
)
# A lockfile entry with one of these, or no source at all, is this repository's.
OWN_SOURCES = ('source = { editable = "." }', 'source = { virtual = "." }')
HEADING = re.compile(
    rf"## (?:\[(?P<linked>{SEMVER})\]\((?P<url>[^)\s]+)\)|(?P<plain>{SEMVER}))"
    r" \((?P<date>\d{4}-\d{2}-\d{2})\)"
)
SUBJECT = re.compile(
    r"(?P<type>[a-z]+)(?:\((?P<scope>[^()]+)\))?(?P<bang>!)?: (?P<text>.+?)(?: \(#(?P<pr>\d+)\))?"
)
BREAKING_FOOTER = re.compile(r"^BREAKING[ -]CHANGE: ", re.M)


class Failure(Exception):
    """Something the person running the script has to fix; the message says what."""


def parse(version: str) -> tuple[int, int, int]:
    if not re.fullmatch(SEMVER, version):
        raise Failure(f"{version!r} is not a version like 1.2.3")
    major, minor, patch = (int(part) for part in version.split("."))
    return major, minor, patch


def read(root: Path, path: str) -> str:
    return (root / path).read_text(encoding="utf-8")


def current(root: Path) -> str:
    text = read(root, SOURCE)
    version = text.strip()
    if text != f"{version}\n" or not re.fullmatch(SEMVER, version):
        raise Failure(f"{SOURCE} must be one line with a version like 1.2.3")
    return version


# --- The copies ---------------------------------------------------------------


def own_entries(text: str, names: tuple[str, ...]) -> dict[str, list[re.Match[str]]]:
    """Each of this repository's packages in a lockfile, where its version is."""
    found: dict[str, list[re.Match[str]]] = {name: [] for name in names}
    for entry in LOCK_ENTRY.finditer(text):
        nxt = entry["next"]
        if entry["name"] in found and (not nxt.startswith("source = ") or nxt in OWN_SOURCES):
            found[entry["name"]].append(entry)
    return found


def copies(root: Path) -> tuple[list[tuple[str, str]], list[str]]:
    """Every copy as (where, the version it says), and the copies that cannot be read."""
    found: list[tuple[str, str]] = []
    problems: list[str] = []
    for path in MARKED:
        lines = list(MARKED_LINE.finditer(read(root, path)))
        if len(lines) != 1:
            problems.append(f"{path} needs exactly one line marked {MARKER}, not {len(lines)}")
        else:
            found.append((path, lines[0]["version"]))
    for path in JSON_COPIES:
        version = json.loads(read(root, path)).get("version")
        if not isinstance(version, str):
            problems.append(f"{path} has no version")
        else:
            found.append((path, version))
    for path, names in LOCKED.items():
        for name, entries in own_entries(read(root, path), names).items():
            if len(entries) != 1:
                problems.append(f"{path} needs exactly one entry for {name}, not {len(entries)}")
            else:
                found.append((f"{path} ({name})", entries[0]["version"]))
    return found, problems


def written(root: Path, version: str) -> dict[str, str]:
    """Each file that holds a copy, as it reads with `version` in its copies."""
    texts: dict[str, str] = {SOURCE: f"{version}\n"}

    def swap(match: re.Match[str]) -> str:
        return f"{match['before']}{version}{match['after']}"

    for path in MARKED:
        text, count = MARKED_LINE.subn(swap, read(root, path))
        if count != 1:
            raise Failure(f"{path} needs exactly one line marked {MARKER}, not {count}")
        texts[path] = text
    for path in JSON_COPIES:
        text, count = JSON_LINE.subn(swap, read(root, path), count=1)
        if count != 1 or json.loads(text).get("version") != version:
            raise Failure(f'{path} has no top-level "version" line this script can write')
        texts[path] = text
    for path, names in LOCKED.items():
        text = read(root, path)
        spans = []
        for name, entries in own_entries(text, names).items():
            if len(entries) != 1:
                raise Failure(f"{path} needs exactly one entry for {name}, not {len(entries)}")
            spans.append(entries[0].span("version"))
        # From the end, so the earlier spans stay where they are.
        for start, end in sorted(spans, reverse=True):
            text = text[:start] + version + text[end:]
        texts[path] = text
    return texts


def set_version(root: Path, version: str) -> list[str]:
    """Writes `version` in version.txt and every copy; returns the files it changed."""
    parse(version)
    # Every file is worked out before any is written, so a failure changes nothing.
    texts = written(root, version)
    changed = [path for path, text in texts.items() if read(root, path) != text]
    for path in changed:
        (root / path).write_text(texts[path], encoding="utf-8")
    return changed


# --- The changelog ------------------------------------------------------------


@dataclass
class Section:
    version: str
    line: int
    url: str | None
    date: str
    heading: str
    body: list[str]


def sections(text: str) -> tuple[list[Section], list[str]]:
    """The changelog's versions, newest first as written, and what is wrong with its form."""
    lines = text.split("\n")
    problems: list[str] = []
    if lines[0] != "# Changelog":
        problems.append(f"{CHANGELOG} must start with the line '# Changelog'")
    found: list[Section] = []
    for number, line in enumerate(lines[1:], start=2):
        if line.startswith("## "):
            heading = HEADING.fullmatch(line)
            if not heading:
                problems.append(
                    f"{CHANGELOG}:{number}: a heading must read '## X.Y.Z (YYYY-MM-DD)' "
                    f"or '## [X.Y.Z](compare link) (YYYY-MM-DD)', not {line!r}"
                )
                found.append(Section("", number, None, "", line, []))
                continue
            version = heading["linked"] or heading["plain"]
            try:
                datetime.date.fromisoformat(heading["date"])
            except ValueError:
                problems.append(f"{CHANGELOG}:{number}: {heading['date']} is not a date")
            found.append(Section(version, number, heading["url"], heading["date"], line, []))
        elif found:
            found[-1].body.append(line)
        elif line.startswith("### ") or line.startswith("* "):
            problems.append(f"{CHANGELOG}:{number}: this belongs under a version's heading")
    return [section for section in found if section.version], problems


def changelog_problems(text: str, version: str) -> list[str]:
    found, problems = sections(text)
    if not found:
        return [*problems, f"{CHANGELOG} has no version"]
    for newer, older in zip(found, found[1:], strict=False):
        if parse(newer.version) <= parse(older.version):
            problems.append(
                f"{CHANGELOG}:{older.line}: {older.version} comes after {newer.version}: "
                "the newest version goes first"
            )
    for index, section in enumerate(found):
        where = f"{CHANGELOG}:{section.line}"
        older = found[index + 1].version if index + 1 < len(found) else None
        if section.url is not None:
            wanted = f"{REPOSITORY}/compare/v{older}...v{section.version}" if older else None
            if section.url != wanted:
                problems.append(f"{where}: {section.version}'s link must be {wanted or 'left out'}")
        bullets = [line for line in section.body if line.startswith("*")]
        if not any(re.match(r"\* \S", line) for line in bullets):
            problems.append(f"{where}: {section.version} lists nothing")
        if any(line.rstrip() == "*" for line in bullets):
            problems.append(f"{where}: {section.version} has an empty bullet")
        # Each subsection lists something before the next one starts.
        subsection = None
        for line in [*section.body, "### "]:
            if line.startswith("### "):
                if subsection is not None:
                    problems.append(f"{where}: {section.version}'s '{subsection}' lists nothing")
                subsection = line[4:]
            elif re.match(r"\* \S", line):
                subsection = None
    if found[0].version != version:
        problems.append(
            f"the newest version in {CHANGELOG} is {found[0].version}, but {SOURCE} says {version}"
        )
    return problems


def check(root: Path) -> list[str]:
    """What is wrong with the version's copies and the changelog; nothing when all agree."""
    try:
        version = current(root)
    except Failure as error:
        return [str(error)]
    found, problems = copies(root)
    for where, says in found:
        if says != version:
            problems.append(
                f"{where} says {says}, {SOURCE} says {version}: run "
                f"python3 scripts/version.py set {version} instead of editing it by hand"
            )
    return problems + changelog_problems(read(root, CHANGELOG), version)


def recorded(text: str, version: str) -> str:
    """`version`'s section exactly as the changelog has it, heading and all (its
    compare link and date): the body of its GitHub Release."""
    found, _ = sections(text)
    for entry in found:
        if entry.version == version:
            return f"{entry.heading}\n\n" + "\n".join(entry.body).strip("\n") + "\n"
    raise Failure(f"{CHANGELOG} has no section for {version}")


# --- Commits and releases -------------------------------------------------------


@dataclass(frozen=True)
class Commit:
    type: str
    scope: str | None
    text: str
    pr: int | None
    breaking: bool

    @property
    def release(self) -> bool:
        return self.type == "chore" and self.scope == "release"


def parse_commit(subject: str, body: str = "") -> Commit | None:
    """A Conventional Commit's subject (and body, for a BREAKING CHANGE footer), or None."""
    match = SUBJECT.fullmatch(subject.strip())
    if not match or match["type"] not in TYPES:
        return None
    return Commit(
        type=match["type"],
        scope=match["scope"],
        text=match["text"],
        pr=int(match["pr"]) if match["pr"] else None,
        breaking=bool(match["bang"]) or bool(BREAKING_FOOTER.search(body)),
    )


def git(root: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    if result.returncode != 0:
        raise Failure(f"git {' '.join(args)}: {result.stderr.strip() or result.returncode}")
    return result.stdout


def changes(root: Path, version: str) -> tuple[list[Commit], list[str]]:
    """The commits on main since `version`'s tag, and the subjects that say no type."""
    tag = f"v{version}"
    try:
        git(root, "rev-parse", "--quiet", "--verify", f"refs/tags/{tag}^{{commit}}")
    except Failure:
        raise Failure(
            f"there is no tag {tag}, the last release's. CI tags a version once its release "
            "pull request is merged; if GitHub has it, run git fetch --tags"
        ) from None
    log = git(root, "log", "--first-parent", "--format=%s%x00%b%x1e", f"{tag}..HEAD")
    commits: list[Commit] = []
    skipped: list[str] = []
    for record in log.split("\x1e"):
        subject, _, body = record.strip("\n").partition("\x00")
        if not subject:
            continue
        commit = parse_commit(subject, body)
        if commit is None:
            skipped.append(subject)
        elif not commit.release:
            commits.append(commit)
    return commits, skipped


def next_version(version: str, commits: list[Commit]) -> str | None:
    """The version these commits call for after `version`; None when there are none."""
    if not commits:
        return None
    major, minor, patch = parse(version)
    if any(commit.breaking for commit in commits):
        return f"0.{minor + 1}.0" if major == 0 else f"{major + 1}.0.0"
    if major > 0 and any(commit.type == "feat" for commit in commits):
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def bullet(commit: Commit) -> str:
    scope = f"**{commit.scope}:** " if commit.scope else ""
    link = f" ([#{commit.pr}]({REPOSITORY}/pull/{commit.pr}))" if commit.pr else ""
    return f"* {scope}{commit.text}{link}"


def section(version: str, previous: str, commits: list[Commit], day: datetime.date) -> str:
    """The changelog section for `version`: breaking changes first, then each type's."""
    groups = [(BREAKING, [commit for commit in commits if commit.breaking])]
    for title, kinds in SECTIONS:
        groups.append(
            (title, [c for c in commits if not c.breaking and not c.release and c.type in kinds])
        )
    lines = [f"## [{version}]({REPOSITORY}/compare/v{previous}...v{version}) ({day.isoformat()})"]
    for title, entries in groups:
        if entries:
            lines += ["", f"### {title}", ""]
            lines += [bullet(c) for c in sorted(entries, key=lambda c: (c.scope or "", c.text))]
    return "\n".join(lines) + "\n"


def release(root: Path, wanted: str | None, push: bool, day: datetime.date) -> tuple[str, str]:
    """Commits the release of `wanted` (or of the next version) on its own branch."""
    problems = check(root)
    if problems:
        raise Failure("fix these first:\n  " + "\n  ".join(problems))
    if git(root, "status", "--porcelain").strip():
        raise Failure("the working tree has changes: commit or stash them first")
    if git(root, "branch", "--show-current").strip() != "main":
        raise Failure("a release starts from main: git switch main && git pull")
    if push:
        # gh opens the pull request; without it, nothing is pushed.
        if shutil.which("gh") is None:
            raise Failure("--push needs gh (https://cli.github.com) to open the pull request")
        git(root, "fetch", "--quiet", "origin", "main")
        if git(root, "rev-parse", "HEAD") != git(root, "rev-parse", "origin/main"):
            raise Failure("main is not at origin/main: git pull first")
    previous = current(root)
    commits, _ = changes(root, previous)
    following = next_version(previous, commits)
    if following is None:
        raise Failure(f"nothing has changed since v{previous}")
    version = wanted or following
    if parse(version) <= parse(previous):
        raise Failure(f"{version} is not after {previous}")
    try:
        git(root, "rev-parse", "--quiet", "--verify", f"refs/tags/v{version}")
    except Failure:
        pass
    else:
        raise Failure(f"v{version} is already tagged")
    notes = section(version, previous, commits, day)
    branch = f"release/{version}"
    git(root, "switch", "--quiet", "--create", branch)
    set_version(root, version)
    head, _, rest = read(root, CHANGELOG).partition("\n")
    rest = rest.lstrip("\n")
    (root / CHANGELOG).write_text(f"{head}\n\n{notes}\n{rest}", encoding="utf-8")
    problems = check(root)
    if problems:
        raise Failure(f"left on {branch}, not committed:\n  " + "\n  ".join(problems))
    title = f"chore(release): {version}"
    git(root, "add", "--", SOURCE, CHANGELOG, *MARKED, *JSON_COPIES, *LOCKED)
    git(root, "commit", "--quiet", "--message", title)
    if push:
        git(root, "push", "--quiet", "--set-upstream", "origin", branch)
        # The section is the pull request's body, and so the squashed commit's.
        create = ["gh", "pr", "create", "--base", "main", "--head", branch, "--title", title]
        try:
            opened = subprocess.run([*create, "--body-file", "-"], input=notes, text=True, cwd=root)
            failed = opened.returncode != 0
        except OSError:
            failed = True
        if failed:
            raise Failure(
                f"{branch} is pushed, but gh could not open its pull request: open it on "
                f"GitHub, titled {title!r}, with the section as its body"
            )
    return version, notes


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="scripts/version.py",
        description="The version of aule-sw, its copies, its changelog and its releases.",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("current", help="print the version")
    commands.add_parser("check", help="exit 1 unless every copy and CHANGELOG.md agree")
    command = commands.add_parser("set", help="write a version in every copy")
    command.add_argument("version")
    commands.add_parser("next", help="the next version, from the commits since the last release")
    command = commands.add_parser("notes", help="the changelog section of those commits")
    command.add_argument("version", nargs="?", help="its heading's version (default: the next)")
    command = commands.add_parser("section", help="a version's section of CHANGELOG.md")
    command.add_argument("version", nargs="?", help="default: the current version")
    command = commands.add_parser("release", help="commit a release on branch release/X.Y.Z")
    command.add_argument("version", nargs="?")
    command.add_argument("--push", action="store_true", help="push it and open its pull request")
    args = parser.parse_args(argv)
    try:
        if args.command == "current":
            print(current(ROOT))
        elif args.command == "check":
            problems = check(ROOT)
            for problem in problems:
                print(problem, file=sys.stderr)
            if problems:
                return 1
            print(f"{current(ROOT)}: every copy and {CHANGELOG} agree")
        elif args.command == "set":
            for path in set_version(ROOT, args.version):
                print(f"wrote {path}")
        elif args.command == "section":
            print(recorded(read(ROOT, CHANGELOG), args.version or current(ROOT)), end="")
        elif args.command in ("next", "notes"):
            previous = current(ROOT)
            commits, skipped = changes(ROOT, previous)
            for subject in skipped:
                print(f"left out, not a Conventional Commit: {subject}", file=sys.stderr)
            following = next_version(previous, commits)
            if following is None:
                raise Failure(f"nothing has changed since v{previous}")
            if args.command == "next":
                print(following)
            else:
                version = args.version or following
                if parse(version) <= parse(previous):
                    raise Failure(f"{version} is not after {previous}")
                print(section(version, previous, commits, datetime.date.today()), end="")
        elif args.command == "release":
            version, _ = release(ROOT, args.version, args.push, datetime.date.today())
            print(f"release/{version} has the commit chore(release): {version}")
            if not args.push:
                print("Review it, then push it and open its pull request (or rerun with --push).")
    except Failure as error:
        print(f"version.py: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
