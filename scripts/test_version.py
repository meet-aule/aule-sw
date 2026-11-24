"""Tests of scripts/version.py, with the standard library only.

    python3 -m unittest discover -s scripts -p 'test_*.py' -v

`set` and `release` run on a temporary copy of the files that hold the
version, never on the repository itself.
"""

import contextlib
import datetime
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import version as tool

FILES = (tool.SOURCE, tool.CHANGELOG, *tool.MARKED, *tool.JSON_COPIES, *tool.LOCKED)
COMPARE = f"{tool.REPOSITORY}/compare"
PULL = f"{tool.REPOSITORY}/pull"
# Git in a test sees none of the machine's settings (signing, hooks, a default branch).
GIT = {
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "Aule test",
    "GIT_AUTHOR_EMAIL": "test@example.org",
    "GIT_COMMITTER_NAME": "Aule test",
    "GIT_COMMITTER_EMAIL": "test@example.org",
}


class Copy(unittest.TestCase):
    """A temporary copy of the files that hold the version."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="aule-version-"))
        self.addCleanup(shutil.rmtree, self.root)
        for path in FILES:
            (self.root / path).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(tool.ROOT / path, self.root / path)

    def text(self, path):
        return (self.root / path).read_text(encoding="utf-8")

    def write(self, path, text):
        (self.root / path).write_text(text, encoding="utf-8")


def commit(subject, body=""):
    parsed = tool.parse_commit(subject, body)
    assert parsed is not None, subject
    return parsed


class TheRepository(unittest.TestCase):
    def test_every_copy_and_the_changelog_agree(self):
        self.assertEqual(tool.check(tool.ROOT), [])

    def test_the_command_line_says_so_and_prints_a_recorded_section(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(tool.main(["check"]), 0)
        self.assertIn("every copy and CHANGELOG.md agree", out.getvalue())
        for argv in (["section", "0.0.1"], ["section"]):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(tool.main(argv), 0)
            self.assertTrue(
                out.getvalue().startswith("## 0.0.1 (2026-11-24)\n\nFirst numbered version."), argv
            )
        error = io.StringIO()
        with contextlib.redirect_stderr(error):
            self.assertEqual(tool.main(["section", "9.9.9"]), 1)
        self.assertIn("no section for 9.9.9", error.getvalue())


class Set(Copy):
    def test_writes_every_copy_and_only_this_repositorys_lock_entries(self):
        before = {path: self.text(path) for path in FILES}

        changed = tool.set_version(self.root, "0.2.0")

        self.assertEqual(sorted(changed), sorted(set(FILES) - {tool.CHANGELOG}))
        self.assertEqual(tool.current(self.root), "0.2.0")
        found, problems = tool.copies(self.root)
        self.assertEqual(problems, [])
        self.assertEqual({says for _, says in found}, {"0.2.0"})
        for path, names in tool.LOCKED.items():
            old, new = before[path].split("\n"), self.text(path).split("\n")
            self.assertEqual(len(old), len(new), path)
            edits = [(a, b) for a, b in zip(old, new, strict=True) if a != b]
            self.assertEqual(len(edits), len(names), f"{path}: only {names}")
            self.assertTrue(all(b == 'version = "0.2.0"' for _, b in edits), edits)
        for path in tool.JSON_COPIES:
            self.assertEqual(
                {**json.loads(before[path]), "version": "0.2.0"}, json.loads(self.text(path))
            )
        self.assertIn('__version__ = "0.2.0"  # x-aule-version', self.text(tool.MARKED[-1]))
        self.assertEqual(self.text(tool.CHANGELOG), before[tool.CHANGELOG])

    def test_then_check_wants_the_changelog_to_say_it_too(self):
        tool.set_version(self.root, "0.0.2")

        self.assertEqual(
            tool.check(self.root),
            ["the newest version in CHANGELOG.md is 0.0.1, but version.txt says 0.0.2"],
        )

    def test_refuses_what_is_not_a_version_and_writes_nothing(self):
        before = {path: self.text(path) for path in FILES}
        for wrong in ("1.2", "01.2.3", "1.2.3-beta", "v1.2.3", ""):
            with self.assertRaises(tool.Failure, msg=wrong):
                tool.set_version(self.root, wrong)
        self.assertEqual({path: self.text(path) for path in FILES}, before)

    def test_check_names_a_copy_edited_by_hand(self):
        path = "contracts/package.json"
        self.write(path, self.text(path).replace('"version": "0.0.1"', '"version": "0.0.9"'))

        (problem,) = tool.check(self.root)

        self.assertIn("contracts/package.json says 0.0.9, version.txt says 0.0.1", problem)
        self.assertIn("python3 scripts/version.py set 0.0.1", problem)

    def test_check_finds_a_lost_marker_and_set_then_writes_nothing(self):
        path = "engine/Cargo.toml"
        self.write(path, self.text(path).replace("  # x-aule-version", ""))
        before = {path: self.text(path) for path in FILES}

        self.assertIn(
            "engine/Cargo.toml needs exactly one line marked x-aule-version, not 0",
            tool.check(self.root),
        )
        with self.assertRaises(tool.Failure):
            tool.set_version(self.root, "0.0.2")
        self.assertEqual({path: self.text(path) for path in FILES}, before)

    def test_check_wants_one_line_in_version_txt(self):
        self.write(tool.SOURCE, "0.0.1\n0.0.2\n")

        self.assertEqual(
            tool.check(self.root), ["version.txt must be one line with a version like 1.2.3"]
        )


GOOD = f"""# Changelog

## [0.0.2]({COMPARE}/v0.0.1...v0.0.2) (2026-11-25)

### Features

* **playground:** show the build ([#5]({PULL}/5))

## 0.0.1 (2026-11-24)

First numbered version. Everything before it is in the git history.

* What exists today.
"""


class Changelog(unittest.TestCase):
    def problems(self, text, version="0.0.2"):
        return tool.changelog_problems(text, version)

    def test_a_good_one_has_no_problem(self):
        self.assertEqual(self.problems(GOOD), [])

    def test_it_starts_with_its_title(self):
        self.assertEqual(
            self.problems(GOOD.replace("# Changelog\n", "# Changes\n")),
            ["CHANGELOG.md must start with the line '# Changelog'"],
        )

    def test_a_heading_names_a_version_and_a_date(self):
        for heading in (
            "## v0.0.2 (2026-11-25)",
            "## 0.0.2",
            "## 0.2 (2026-11-25)",
            "## 0.0.02 (2026-11-25)",
        ):
            text = GOOD.replace(f"## [0.0.2]({COMPARE}/v0.0.1...v0.0.2) (2026-11-25)", heading)
            self.assertTrue(any("a heading must read" in p for p in self.problems(text)), heading)
        text = GOOD.replace("(2026-11-25)", "(2026-13-40)")
        self.assertIn("CHANGELOG.md:3: 2026-13-40 is not a date", self.problems(text))

    def test_the_newest_goes_first(self):
        text = "# Changelog\n\n## 0.0.1 (2026-11-24)\n\n* a\n\n## 0.0.2 (2026-11-25)\n\n* b\n"
        self.assertIn(
            "CHANGELOG.md:7: 0.0.2 comes after 0.0.1: the newest version goes first",
            self.problems(text, "0.0.1"),
        )

    def test_no_section_is_empty(self):
        empty = GOOD.replace(f"* **playground:** show the build ([#5]({PULL}/5))\n", "")
        self.assertIn("CHANGELOG.md:3: 0.0.2 lists nothing", self.problems(empty))
        hollow = GOOD.replace("### Features\n", "### Features\n\n### Bug Fixes\n")
        self.assertEqual(
            self.problems(hollow), ["CHANGELOG.md:3: 0.0.2's 'Features' lists nothing"]
        )
        trailing = GOOD.replace(
            f"([#5]({PULL}/5))\n",
            f"([#5]({PULL}/5))\n\n### Chores\n",
        )
        self.assertEqual(
            self.problems(trailing), ["CHANGELOG.md:3: 0.0.2's 'Chores' lists nothing"]
        )
        blank = GOOD.replace("* What exists today.", "* What exists today.\n*")
        self.assertEqual(self.problems(blank), ["CHANGELOG.md:9: 0.0.1 has an empty bullet"])

    def test_a_link_compares_with_the_version_before(self):
        text = GOOD.replace("v0.0.1...v0.0.2", "v0.0.0...v0.0.2")
        self.assertEqual(
            self.problems(text),
            [f"CHANGELOG.md:3: 0.0.2's link must be {COMPARE}/v0.0.1...v0.0.2"],
        )

    def test_its_newest_version_is_the_version(self):
        self.assertEqual(
            self.problems(GOOD, "0.0.3"),
            ["the newest version in CHANGELOG.md is 0.0.2, but version.txt says 0.0.3"],
        )

    def test_a_recorded_section_is_exactly_the_changelogs_heading_and_all(self):
        self.assertEqual(
            tool.recorded(GOOD, "0.0.2"),
            f"## [0.0.2]({COMPARE}/v0.0.1...v0.0.2) (2026-11-25)\n\n"
            f"### Features\n\n* **playground:** show the build ([#5]({PULL}/5))\n",
        )
        self.assertEqual(
            tool.recorded(GOOD, "0.0.1"),
            "## 0.0.1 (2026-11-24)\n\n"
            "First numbered version. Everything before it is in the git history.\n\n"
            "* What exists today.\n",
        )
        with self.assertRaises(tool.Failure):
            tool.recorded(GOOD, "0.0.3")


class Commits(unittest.TestCase):
    def test_a_subject_is_read_as_a_conventional_commit(self):
        self.assertEqual(
            tool.parse_commit("feat(playground): say which build answers (#192)"),
            tool.Commit("feat", "playground", "say which build answers", 192, False),
        )
        self.assertEqual(
            tool.parse_commit("fix: a request for (#3) works"),
            tool.Commit("fix", None, "a request for (#3) works", None, False),
        )
        self.assertTrue(commit("refactor(platform)!: one route for both (#7)").breaking)
        self.assertTrue(
            commit("feat: plans (#9)", "Why.\n\nBREAKING CHANGE: no free plan\n").breaking
        )
        self.assertFalse(commit("feat: plans (#9)", "Says BREAKING CHANGE: in passing.").breaking)
        self.assertTrue(commit("chore(release): 0.0.2 (#20)").release)
        for subject in (
            "Merge pull request #15 from meet-aule/x",
            "wip: something",
            "Fix: capital",
        ):
            self.assertIsNone(tool.parse_commit(subject), subject)

    def test_before_1_0_a_breaking_change_bumps_the_minor_and_the_rest_the_patch(self):
        fix, feat, docs = commit("fix: a"), commit("feat: b"), commit("docs: c")
        breaking = commit("fix!: d")
        self.assertEqual(tool.next_version("0.0.1", [fix]), "0.0.2")
        self.assertEqual(tool.next_version("0.0.1", [feat, fix]), "0.0.2")
        self.assertEqual(tool.next_version("0.3.4", [docs]), "0.3.5")
        self.assertEqual(tool.next_version("0.3.4", [feat, breaking]), "0.4.0")
        self.assertIsNone(tool.next_version("0.0.1", []))

    def test_after_1_0_semver_as_usual(self):
        self.assertEqual(tool.next_version("1.2.3", [commit("fix: a")]), "1.2.4")
        self.assertEqual(tool.next_version("1.2.3", [commit("feat: a")]), "1.3.0")
        self.assertEqual(tool.next_version("1.2.3", [commit("feat!: a")]), "2.0.0")

    def test_a_section_puts_breaking_changes_first_then_each_type_in_order(self):
        commits = [
            commit("test(agent): cover the gates (#8)"),
            commit("fix(platform): keep the token (#6)"),
            commit("feat(playground): show the build (#5)"),
            commit("refactor(platform)!: one route for both (#7)"),
            commit("docs: say how to release"),
            commit("feat(agent): say hello (#4)"),
            commit("perf: fewer queries (#3)"),
            commit("chore(release): 0.0.1 (#2)"),
        ]
        self.assertEqual(
            tool.section("0.1.0", "0.0.1", commits, datetime.date(2026, 11, 25)),
            f"""## [0.1.0]({COMPARE}/v0.0.1...v0.1.0) (2026-11-25)

### ⚠ BREAKING CHANGES

* **platform:** one route for both ([#7]({PULL}/7))

### Features

* **agent:** say hello ([#4]({PULL}/4))
* **playground:** show the build ([#5]({PULL}/5))

### Bug Fixes

* **platform:** keep the token ([#6]({PULL}/6))

### Performance

* fewer queries ([#3]({PULL}/3))

### Documentation

* say how to release

### Chores

* **agent:** cover the gates ([#8]({PULL}/8))
""",
        )


class Release(Copy):
    """`release` in a git repository of its own, made from the copy."""

    def setUp(self):
        super().setUp()
        patcher = mock.patch.dict(os.environ, GIT)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.git("init", "--quiet", "--initial-branch", "main")
        self.git("add", ".")
        self.git(
            "commit", "--quiet", "--message", "chore: reset every package's version to 0.0.1 (#191)"
        )
        self.git("tag", "v0.0.1")

    def git(self, *args):
        return subprocess.run(
            ["git", "-C", str(self.root), *args], check=True, capture_output=True, text=True
        ).stdout.strip()

    def land(self, *subjects):
        for subject in subjects:
            self.git("commit", "--quiet", "--allow-empty", "--message", subject)

    def test_next_and_notes_read_the_commits_since_the_last_tag(self):
        self.land(
            "feat(playground): show the build (#5)",
            "Merge pull request #7 from meet-aule/old",
            "fix: keep the token (#6)",
        )
        commits, skipped = tool.changes(self.root, "0.0.1")

        self.assertEqual([c.pr for c in commits], [6, 5])
        self.assertEqual(skipped, ["Merge pull request #7 from meet-aule/old"])
        self.assertEqual(tool.next_version("0.0.1", commits), "0.0.2")

    def test_commits_the_release_on_its_branch(self):
        self.land("feat(playground): show the build (#5)", "fix: keep the token (#6)")

        version, notes = tool.release(self.root, None, False, datetime.date(2026, 11, 25))

        self.assertEqual(version, "0.0.2")
        self.assertEqual(self.git("branch", "--show-current"), "release/0.0.2")
        self.assertEqual(self.git("log", "-1", "--format=%s"), "chore(release): 0.0.2")
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertEqual(tool.check(self.root), [])
        self.assertEqual(
            notes,
            f"""## [0.0.2]({COMPARE}/v0.0.1...v0.0.2) (2026-11-25)

### Features

* **playground:** show the build ([#5]({PULL}/5))

### Bug Fixes

* keep the token ([#6]({PULL}/6))
""",
        )
        self.assertTrue(
            self.text(tool.CHANGELOG).startswith(f"# Changelog\n\n{notes}\n## 0.0.1 (2026-11-24)\n")
        )
        # The GitHub Release will say exactly what the pull request said.
        self.assertEqual(tool.recorded(self.text(tool.CHANGELOG), "0.0.2"), notes)
        self.assertEqual(
            sorted(self.git("show", "--name-only", "--format=", "HEAD").split("\n")), sorted(FILES)
        )
        # The tag is CI's to make, after the merge.
        self.assertEqual(self.git("tag", "--list"), "v0.0.1")

    def test_notes_are_headed_with_the_next_version_or_a_chosen_one(self):
        self.land("feat(playground): show the build (#5)")

        def run(*argv):
            out, error = io.StringIO(), io.StringIO()
            with (
                mock.patch.object(tool, "ROOT", self.root),
                contextlib.redirect_stdout(out),
                contextlib.redirect_stderr(error),
            ):
                code = tool.main(list(argv))
            return code, out.getvalue(), error.getvalue()

        code, out, _ = run("notes")
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith(f"## [0.0.2]({COMPARE}/v0.0.1...v0.0.2) ("), out)
        code, out, _ = run("notes", "0.1.0")
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith(f"## [0.1.0]({COMPARE}/v0.0.1...v0.1.0) ("), out)
        self.assertIn(f"* **playground:** show the build ([#5]({PULL}/5))\n", out)
        code, _, error = run("notes", "0.0.1")
        self.assertEqual(code, 1)
        self.assertIn("0.0.1 is not after 0.0.1", error)

    def test_push_without_gh_pushes_nothing(self):
        self.land("fix: keep the token (#6)")

        with mock.patch.object(tool.shutil, "which", return_value=None):
            with self.assertRaisesRegex(tool.Failure, "gh"):
                tool.release(self.root, None, True, datetime.date(2026, 11, 25))

        self.assertEqual(self.git("branch", "--show-current"), "main")
        self.assertEqual(self.git("branch", "--list", "release/*"), "")

    def test_a_gh_that_cannot_run_after_the_push_is_a_failure_not_a_traceback(self):
        remote = Path(tempfile.mkdtemp(prefix="aule-version-remote-"))
        self.addCleanup(shutil.rmtree, remote)
        self.git("init", "--quiet", "--bare", "--initial-branch", "main", str(remote))
        self.git("remote", "add", "origin", str(remote))
        self.land("fix: keep the token (#6)")
        self.git("push", "--quiet", "origin", "main")
        real = subprocess.run

        def run(command, *args, **kwargs):
            if command[0] == "gh":
                raise FileNotFoundError(2, "No such file or directory", "gh")
            return real(command, *args, **kwargs)

        with (
            mock.patch.object(tool.shutil, "which", return_value="/usr/bin/gh"),
            mock.patch.object(tool.subprocess, "run", run),
        ):
            with self.assertRaisesRegex(tool.Failure, "release/0.0.2 is pushed, but gh could not"):
                tool.release(self.root, None, True, datetime.date(2026, 11, 25))

        self.assertIn("refs/heads/release/0.0.2", self.git("ls-remote", "--heads", "origin"))

    def test_a_version_can_be_chosen_but_not_one_before(self):
        self.land("feat: the first lesson (#9)")

        self.assertEqual(
            tool.release(self.root, "1.0.0", False, datetime.date(2026, 12, 1))[0], "1.0.0"
        )
        self.git("switch", "--quiet", "main")
        with self.assertRaisesRegex(tool.Failure, "0.0.1 is not after 0.0.1"):
            tool.release(self.root, "0.0.1", False, datetime.date(2026, 12, 1))

    def test_refuses_without_changes_a_clean_tree_main_or_the_last_tag(self):
        day = datetime.date(2026, 11, 25)
        with self.assertRaisesRegex(tool.Failure, "nothing has changed since v0.0.1"):
            tool.release(self.root, None, False, day)
        self.land("chore(release): 0.0.1 (#4)")
        with self.assertRaisesRegex(tool.Failure, "nothing has changed since v0.0.1"):
            tool.release(self.root, None, False, day)

        self.land("fix: keep the token (#6)")
        self.write("README.md", "unsaved\n")
        with self.assertRaisesRegex(tool.Failure, "commit or stash"):
            tool.release(self.root, None, False, day)
        (self.root / "README.md").unlink()

        self.git("switch", "--quiet", "--create", "feature")
        with self.assertRaisesRegex(tool.Failure, "starts from main"):
            tool.release(self.root, None, False, day)
        self.git("switch", "--quiet", "main")

        self.git("tag", "--delete", "v0.0.1")
        with self.assertRaisesRegex(tool.Failure, "there is no tag v0.0.1"):
            tool.release(self.root, None, False, day)
        self.assertEqual(self.git("branch", "--list", "release/*"), "")


if __name__ == "__main__":
    unittest.main()
