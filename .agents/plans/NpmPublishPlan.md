# Plan: Publish `pi-caffeinated-linux` to npm

## Goal

Publish the Linux-only Pi extension as a reproducible public npm release that
users can install with `pi install npm:@nimendra/pi-caffeinated-linux`, while
validating the published tarball and linking the release to the GitHub source
through GitHub Actions provenance.

## Current State

- The release package is now named `@nimendra/pi-caffeinated-linux` at version
  `0.0.1` (`package.json:2-4`), and the lockfile root mirrors that name and
  version (`package-lock.json:1-9`).
- `npm view @nimendra/pi-caffeinated-linux ... --json` returned 404, and the
  `nimendra` organization is the selected npm scope. The existing unrelated
  `pi-caffeinated@0.1.2` package must not be modified or republished.
- The package is already shaped as a Pi package: it has the `pi-package` and
  `pi-extension` keywords, an extension entry at `package.json:58-62`, runtime
  `dbus-next` in `dependencies` (`package.json:44-45`), Pi core packages in
  `peerDependencies` (`package.json:47-55`), and an explicit six-file publish
  allowlist (`package.json:37-43`). Pi package documentation confirms that
  runtime dependencies belong in `dependencies`, Pi core packages should be
  peers, and the `pi` manifest declares extension resources:
  <https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/packages.md>.
- The README already documents installation from npm and the automatic/manual
  `/caffeinate` modes (`README.md:31-57`). The current working tree also has
  uncommitted implementation, documentation, test, plan, and deletion changes;
  those must be finalized before release.
- The package metadata has been updated to the git `origin`
  `https://github.com/nmdra/pi-caffeinated-linux` in `package.json:21-29`.
- The requested npm organization is `nimendra`, but the current shell still
  returns `E401 Unauthorized` from `npm whoami`; authentication and
  organization membership must be re-established before publication. The
  workflow also requires npm Trusted Publishing/OIDC configuration for
  `@nimendra/pi-caffeinated-linux` before its publish job can succeed.
- npm documents `npm pack --dry-run` as the no-write package-content preview and
  `npm publish` as the registry publication command:
  <https://docs.npmjs.com/cli/v12/commands/npm-pack/> and
  <https://docs.npmjs.com/cli/v12/commands/npm-publish/>.

## Decisions

1. **Publish `@nimendra/pi-caffeinated-linux@0.0.1`.** Use the `nimendra`
   organization as the npm scope and set public access explicitly. This is a
   new package name, so it does not conflict with the existing unscoped
   `pi-caffeinated@0.1.2` package.
2. **Make the source metadata match the intended public repository.** Use the
   current GitHub origin (`nmdra/pi-caffeinated-linux`) for `repository`,
   `homepage`, and `bugs`. Keep the existing author and MIT license unless the
   maintainer explicitly changes them.
3. **Prefer a GitHub Actions provenance release.** npm provenance requires a
   supported cloud CI/CD runner; npm currently documents GitHub Actions and
   GitLab CI/CD as supported, and trusted publishing can avoid long-lived npm
   tokens:
   <https://docs.npmjs.com/generating-provenance-statements/>.
4. **Keep local publishing as a documented fallback.** If trusted publishing is
   not configured, an authenticated maintainer may run `npm publish
   --access public` locally and complete npm 2FA. The fallback does not claim
   CI provenance.
5. **Use the organization scope as the ownership gate.** Confirm the logged-in
   account is a member of `nimendra` and can publish public packages under
   `@nimendra`. If scope access is missing, stop rather than publishing under a
   different account or silently changing the package name.
6. **Pin the released Pi package in verification.** Pi documentation notes that
   npm package references can be pinned to avoid unexpected updates:
   <https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/packages.md>.

## Scope

In scope:

- Finalizing the current source and README changes for release.
- Auditing and correcting npm/GitHub metadata.
- Bumping `package.json` and `package-lock.json` to `0.0.1`.
- Adding a repeatable prepublish quality gate and, preferably, a GitHub Actions
  provenance workflow.
- Inspecting and smoke-testing the exact npm tarball on Linux.
- Publishing the package, applying the `latest` tag, tagging the source release,
  and verifying installation through Pi.

Intentionally out of scope:

- Publishing under a different scope or package name without resolving the
  `nimendra` organization access gate.
- Rewriting the extension implementation during release preparation.
- Bundling Pi core packages or changing the Linux/systemd/KDE runtime contract.
- Publishing secrets, npm tokens, local `.npmrc` files, tests, plans, or
  development dependencies in the package tarball.
- Automatically publishing every future commit without an explicit release
  process.

## Tasks

- [ ] **Task 1: Resolve scoped registry ownership and release metadata.** Confirm
  the logged-in npm account is a member of the `nimendra` organization and can
  publish public scoped packages. Confirm that `@nimendra/pi-caffeinated-linux`
  is unused, then reconcile `package.json` repository, homepage, bugs, author,
  keywords, `os`, `files`, `publishConfig.access`, `pi.extensions`,
  dependencies, and peer dependencies with the public GitHub repository and Pi
  package rules.
  **Files:** `package.json`, `README.md`.
  **Seam:** scoped npm manifest and organization ownership gate.
  **Verify:** `npm whoami`; `npm org ls nimendra`; `npm view
  @nimendra/pi-caffeinated-linux --json`; inspect `npm pkg get name version
  repository homepage files os publishConfig pi dependencies peerDependencies`.

- [ ] **Task 2: Finalize the release candidate and set the initial version.**
  Review the current uncommitted auto/manual mode changes, remove stale overlay
  references, set the package version to `0.0.1`, and update the lockfile root
  version with `npm version 0.0.1 --no-git-tag-version` or an equivalent
  lockfile-safe command. Add `prepublishOnly` to run `npm run check && npm test`
  before a local or CI publication.
  **Files:** `caffeinate.ts`, `README.md`, `package.json`, `package-lock.json`,
  `.agents/plans/Plan.md`, `.agents/plans/NpmPublishPlan.md`.
  **Seam:** package version/manifest and existing automated test entry points.
  **Verify:** `npm run check && npm test`; assert both manifest versions are
  `0.0.1`; grep source and README for removed overlay/old behavior.

- [ ] **Task 3: Add the release-please provenance workflow.** Mirror the
  `nmdra/erpbridge-sdk` release pattern: on pushes to `main`, let
  `googleapis/release-please-action` open a release PR and cut the GitHub
  release/tag; when a release is created, check out the tagged commit, install
  with `npm ci`, run the prepublish checks, and publish
  `@nimendra/pi-caffeinated-linux@0.0.1` with
  `npm publish --provenance --access public`. Configure npm Trusted
  Publishing/OIDC for `nmdra/pi-caffeinated-linux` and this exact workflow;
  do not store an npm token in the repository.
  **Files:** `.github/workflows/release.yml`, `.github/dependabot.yml`,
  `release-please-config.json`, `.release-please-manifest.json`, `CHANGELOG.md`.
  **Seam:** release-please PR/tag lifecycle, dependency maintenance, and npm
  trusted-publisher settings.
  **Verify:** validate workflow and Dependabot YAML plus release-please JSON,
  confirm the workflow has `id-token: write`, and verify npm trusted-publisher
  settings match `nmdra/pi-caffeinated-linux/.github/workflows/release.yml`.

- [ ] **Task 4: Validate the exact package tarball before publication.** Run
  `npm pack --dry-run --json`, inspect the package file list, and create a real
  tarball only in a temporary directory. Confirm it contains the README,
  license, Pi entrypoint, Linux backend, and KDE notifier, but excludes tests,
  plans, `tsconfig.json`, `node_modules`, and dev-only tooling. Install the
  tarball into a clean temporary consumer and verify `dbus-next` is resolved as
  a production dependency and the Pi manifest exposes the extension.
  **Files:** `package.json`, `package-lock.json`, `README.md`, `caffeinate.ts`,
  `linux-awake.ts`, `kde-status-notifier.ts`.
  **Seam:** npm packlist and clean consumer installation.
  **Verify:** `npm pack --dry-run --json`; `npm pack --pack-destination
  "$TMPDIR"`; in a clean Linux temp directory run `npm install
  /path/to/nimendra-pi-caffeinated-linux-0.0.1.tgz` and inspect `npm ls --omit=dev dbus-next`.

- [ ] **Task 5: Run release-quality Linux and Pi checks.** From a clean checkout,
  run `npm ci`, `npm run check`, and `npm test`. Run the real systemd and KDE
  smoke checks already used by this project: start the fixed
  `systemd-inhibit --what=idle:sleep` command, inspect it with
  `systemd-inhibit --list`, start the notifier under the session bus, inspect
  both StatusNotifierItem interfaces with `qdbus6 --session`, and verify that
  auto mode stops at `agent_settled` while manual mode remains active until a
  user stop. Confirm no inhibitor or tray service remains after each test.
  **Files:** no source changes; release candidate only.
  **Seam:** published-package runtime entrypoint and existing lifecycle tests.
  **Verify:** `npm ci && npm run check && npm test`; live `systemd-inhibit`,
  `dbus-run-session`/KDE `qdbus6`, and Pi `--extension` load checks; assert
  `systemd-inhibit --list` has no stale `pi-caffeinated` entry afterward.

- [ ] **Task 6: Commit and publish the release.** Commit the finalized source,
  metadata, workflow, tests, and version bump with a Conventional Commit. Push
  the commit and `v0.0.1` tag to the intended GitHub origin. Configure npm Trusted Publishing for `@nimendra/pi-caffeinated-linux`, then
  let the release-please workflow publish `0.0.1` with the `latest` dist-tag.
  If using the local fallback, run `npm whoami` immediately before `npm
  publish --access public`, complete 2FA, and record the published version
  without using `--no-verify`.
  **Files:** all release-candidate files plus the release-please workflow and
  manifests.
  **Seam:** release-please GitHub release → OIDC npm publish.
  **Verify:** `git status --short`; `git show v0.0.1`; successful GitHub Actions
  run or npm publish output; no credentials in `git diff` or repository files.

- [ ] **Task 7: Verify the registry release and Pi installation.** Query the
  registry for the exact version, dist-tag, tarball integrity, metadata, and
  provenance/signatures where available. In a clean Linux Pi environment,
  install the pinned package with
  `pi install npm:@nimendra/pi-caffeinated-linux@0.0.1`, confirm
  it appears in `pi list`, load it, and exercise `/caffeinate` and
  `/caffeinate manual`. Update the README or release notes only if the final
  registry URL or install syntax differs from the candidate documentation.
  **Files:** `README.md` only if verification finds a documentation mismatch.
  **Seam:** npm registry artifact and Pi package loader.
  **Verify:** `npm view @nimendra/pi-caffeinated-linux@0.0.1 --json`;
  `npm audit signatures`
  when provenance/signatures exist; `pi install
  npm:@nimendra/pi-caffeinated-linux@0.0.1`; `pi list`; clean Pi smoke test;
  final
  `systemd-inhibit --list` cleanup check.

## Verification

Acceptance requires all of the following:

1. The npm account is authenticated and authorized to publish public packages
   in the `nimendra` organization under `@nimendra`.
2. `package.json` and `package-lock.json` both report `0.0.1`, and the metadata
   points to the intended public source repository.
3. `npm run check`, `npm test`, and the prepublish hook pass from a clean install.
4. The dry-run and real tarball contain only the six intended package files plus
   npm's generated `package.json`; no tests, plans, development dependencies,
   or local credentials are shipped.
5. A clean consumer installs `dbus-next` as a production dependency and Pi
   discovers `./caffeinate.ts` from the `pi` manifest.
6. The release is published as `@nimendra/pi-caffeinated-linux@0.0.1` under
   `latest`; the provenance workflow succeeds if Trusted Publishing is
   enabled, otherwise the authenticated fallback is recorded.
7. `pi install npm:@nimendra/pi-caffeinated-linux@0.0.1` succeeds on Linux,
   and both automatic and manual caffeinate modes retain their documented stop
   and cleanup paths.

## Open Questions

- Re-authenticate npm in the current shell and confirm membership in the
  `nimendra` organization; `npm whoami` currently returns `E401 Unauthorized`.
- Configure npm Trusted Publishing for package
  `@nimendra/pi-caffeinated-linux` and workflow
  `nmdra/pi-caffeinated-linux/.github/workflows/release.yml` before release.
