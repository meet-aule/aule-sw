# Releasing

## The version rules

Everything in this repository shares one version, in [Semantic Versioning](https://semver.org).
Before 1.0:

- a breaking change (`!` in the title, or a `BREAKING CHANGE:` line in the body) bumps the minor: 0.3.4 → 0.4.0;
- anything else, `feat` and `fix` included, bumps the patch: 0.3.4 → 0.3.5;
- 1.0.0 is a decision made by hand, never by the tool.

The bump and the changelog come from the titles of the pull requests merged since
the last release, which is why they follow Conventional Commits ([CONTRIBUTING.md](CONTRIBUTING.md)).

## Where the version lives

`version.txt` is the version. These copy it:

- `apps/admin/package.json`, `apps/playground/package.json`, `contracts/package.json` and `curriculum/package.json`;
- `apps/platform/Cargo.toml`, `engine/Cargo.toml` (`[workspace.package]`) and their own entries in `apps/platform/Cargo.lock` and `engine/Cargo.lock`;
- `apps/agent/pyproject.toml`, `apps/agent/src/aule_agent/_version.py` and the agent's own entry in `apps/agent/uv.lock`.

A copy that can carry a comment ends with `x-aule-version`. Never edit a version by
hand: `python3 scripts/version.py set X.Y.Z` writes them all, lockfiles included, and
`python3 scripts/version.py check`, which CI runs, fails when a copy or `CHANGELOG.md` disagrees.

## Cutting a release

On `main`, up to date and with nothing uncommitted:

```bash
python3 scripts/version.py release --push        # or: release X.Y.Z --push
```

It works out the next version from the commits since the last tag (`next` and `notes`
show it beforehand), writes it everywhere, puts its section at the top of `CHANGELOG.md`,
commits `chore(release): X.Y.Z` on the branch `release/X.Y.Z`, pushes it and opens the
pull request with that section as its body. Without `--push` it stops after the commit.
Read the section, improve its words in the pull request if they need it, and merge it
like any other. Merge it before anything else lands: if `main` moves first, close it,
delete the branch and run the command again, or the commits in between are in no
release's notes.

## What CI does after the merge

`.github/workflows/release.yml` runs when `version.txt` changes on `main`. It checks the
copies again, tags the release commit `vX.Y.Z` and publishes the GitHub Release `vX.Y.Z`,
whose body is that version's section of `CHANGELOG.md`. A version already tagged is left
alone, so running it again by hand (Actions, Release, Run workflow) is safe. It deploys
nothing: the server is updated as before ([infra/server](infra/server/README.md)).

## Where to see the running version

- The page: the last line of «Mi cuenta y mis datos», `Aule 0.0.1 · abc1234` (only
  `Aule 0.0.1` while the commit is unknown), and its `aule-version` and `aule-commit` meta tags.
- https://playground.meetaule.com/session/healthz: `{"ok":true,"version":"0.0.1","commit":"abc123456789"}`.
- The team's panel, under its title: the page's and the platform's version and commit.
- The logs, at start: `aule-playground 0.0.1 (abc123456789)`, `aule-agent 0.0.1 (abc123456789)`,
  and the platform's `version` and `commit` fields. In its container, `aule-platform version`
  prints `aule-platform 0.0.1 (abc123456789)`.
- Each request to the platform: `User-Agent: aule-playground/0.0.1 (+abc1234)` or `aule-agent/0.0.1 (+abc1234)`.

The commit comes from the `AULE_COMMIT` build argument: `infra/server/aule-compose.sh`
takes it from the checkout in `/opt/aule-sw`, and CI from the commit it builds; without
it, the builds say `unknown`. The server runs its own copy of that script,
`/etc/aule/aule-compose.sh`, a separate install: it passes the commit only once it is
installed again from the repository. Because each build carries its commit, a rebuilt
service restarts after any new commit; name only the services that changed ([infra/server](infra/server/README.md)).

This follows how Anthropic releases its SDKs: a single version source, a release pull
request, then a tag and a GitHub Release from the changelog.
