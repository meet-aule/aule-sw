# Contributing

## Pull requests

Use a pull request for changes to `main`. The branch must include the latest base
commit, all required checks must pass, and review conversations must be resolved.
The rules apply to administrators too. There is no automatic merge.

GitHub does not require a second reviewer's approval, so a sole maintainer can
merge their own PR after reviewing it. Agents still follow the workspace's human
approval requirements.

## Titles and merge history

Use `type(scope): concrete action and result`; the scope is optional.
Supported types are `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`,
`ci`, `chore`, `style`, and `revert`. Use `!` for a breaking change.

Examples:

- `fix(agent): preserve queued events during reconnect`
- `fix(display): restore the wake hint after reconnecting`
- `ci(actions): update checkout and artifact actions`

The title check enforces the format, a 120-character limit, and rejects obvious
placeholders. The author and reviewer must still verify that the title describes
the actual diff. Editing a title reruns only its metadata check, without rebuilding
the application or firmware. The workflow reads the event as JSON and does not
check out or execute PR code.

PRs are squash-merged. The default commit subject is the PR title, and its body is
the PR description. Keep that description focused on the final change and evidence.

## Releases

The titles decide the next version and what the changelog says about it.
[RELEASING.md](RELEASING.md) says how a release is cut. Never edit a version number
by hand; `scripts/version.py` writes them all.

## Required checks

- `Software CI`: Node contracts/playground/curriculum tests, Python tests, Rust
  formatting and tests against PostgreSQL 17 with pgvector, all three Docker builds,
  the version's copies and the changelog with the tests of `scripts/version.py`,
  and the reproducible student performance benchmark on pinned public data.
- `Ruff`: Python lint and formatting.
- `Clippy and RustSec`: Rust lint and the dependency audit.
- `Workflows, shell scripts and Dockerfiles`: actionlint, ShellCheck and Hadolint.
- `PR title`: title format and obvious placeholders.

The build gate fails if any prerequisite fails, is cancelled, or is skipped.
Required workflows run on every PR, including documentation and Dependabot changes;
there are no path filters that can leave required checks pending indefinitely.
The manual runner smoke test is not a merge requirement.
PR code runs on GitHub-hosted runners. The shared Aule runner remains limited to
the approved default-branch workflows.

## Dependencies

Actions are pinned to a commit and images to a digest, each with its version in
a comment; Dependabot proposes the updates. Nothing new comes in until it is a
week old: Dependabot waits seven days (`cooldown`), and pnpm will not install a
version younger than that (`minimumReleaseAge`), nor one that lost the
provenance its earlier versions had, nor a dependency from outside the registry.

## GitHub configuration

`.github/ruleset.json` records the intended branch rules, and
`.github/repository-settings.json` records the merge settings. These files are
review material; workflows do not apply administrative settings.

When renaming required checks, update the ruleset at the same time. Apply the
rules only after the checks have run successfully, and verify the active rules
through GitHub's API. Existing PRs must update their base to receive new checks.
