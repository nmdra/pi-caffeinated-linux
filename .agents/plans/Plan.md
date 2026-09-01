# Plan: Secure and harden pi-caffeinated-linux 0.0.2

## Goal

Ship a reliable `0.0.2` release of the Linux-only Pi extension: replace the
vulnerable `dbus-next` D-Bus stack with pure-JavaScript `dbus-native`, make
shutdown and diagnostics dependable, improve tray accessibility and tests,
correct the npm author to **NIMENDRA**, and make the next release publish with
npm Trusted Publishing and provenance.

## Current State

- `package.json` declares `dbus-next@^0.10.2` as the only runtime dependency
  and has an incorrect author value (`package.json:7`, `package.json:45-47`).
  `npm audit --omit=dev` reports 10 production findings, including 3 critical,
  through `dbus-next → usocket → node-gyp → request/tar`.
- The tray service uses `dbus-next` to claim a name, export KDE and
  freedesktop StatusNotifierItem interfaces, register with a watcher, and emit
  property signals (`kde-status-notifier.ts:1-6`, `:404-456`, `:563-586`).
- The active-session finalizer clears timers/listeners/status, terminates the
  inhibitor, and awaits tray cleanup (`caffeinate.ts:130-175`). However, the
  `process.exit` listener starts that asynchronous finalizer without being able
  to await it (`caffeinate.ts:302-305`).
- `terminateProcess()` does not distinguish a failed `ChildProcess.kill()`
  result from a sent signal (`linux-awake.ts:50-64`).
- The release workflow already requests `id-token: write` and runs
  `npm publish --provenance`, but the npm trusted-publisher configuration has
  not been created (`.github/workflows/release.yml:27-56`). The `0.0.1` publish
  workflow therefore failed with `ENEEDAUTH`.
- The current tests use injectable child-process, Pi UI, tray, and fake D-Bus
  seams (`test/caffeinate.test.ts`, `test/kde-status-notifier.test.ts`), but do
  not cover pending tray startup races or process-signal cleanup.

External evidence:

- `dbus-native@0.15.2` is a pure-JavaScript D-Bus client/server with service
  export support, requires Node `>=22.12.0`, and has only `xml2js` as a runtime
  dependency: <https://sidorares.github.io/dbus-native/> and
  <https://www.npmjs.com/package/dbus-native>.
- A clean temporary install of `dbus-native@0.15.2` produced 0 runtime audit
  findings; the package lock contained 3 transitive runtime packages.
- npm Trusted Publishing requires a configured repository and workflow, a
  cloud-hosted GitHub Actions runner, and `id-token: write`; public GitHub
  packages published that way receive provenance automatically:
  <https://docs.npmjs.com/trusted-publishers/> and
  <https://docs.npmjs.com/generating-provenance-statements/>.

## Decisions

1. **D-Bus library:** Replace `dbus-next` with `dbus-native@^0.15.2`. Preserve
   the existing StatusNotifierItem contract—both KDE and freedesktop
   interfaces, KDE watcher then freedesktop fallback, pixmaps, tooltip updates,
   and click-to-stop—but adapt it behind the existing `KdeStatusNotifier` API.
   Do not use a native addon because Pi extensions must remain installable with
   `pi install` and no compiler or system development headers.
2. **Runtime baseline:** Raise the package Node engine to `>=22.12.0`, matching
   the selected D-Bus library. Pi instances below that version must fail at
   install time rather than loading an incompatible extension.
3. **Shutdown contract:** Treat `session_shutdown` as the awaited normal Pi
   cleanup path. For host termination, handle `SIGINT` and `SIGTERM` with a
   bounded cleanup path and retain `exit` only for synchronous best-effort
   child signalling; never promise asynchronous D-Bus cleanup from `exit`.
4. **Footer status:** Keep the technical inhibitor details in diagnostics and
   the tray tooltip, but show one short randomly selected coffee quote in the
   colored Pi footer for each active session. Select it once at startup so the
   status does not flicker on its one-second elapsed-time updates.
5. **Diagnostics:** User-facing warnings remain one-time and non-fatal for
   optional tray support, but include the failed stage and concise cause.
   Inhibitor termination returns structured signal results so permission/PID
   failures are not reported as successful cleanup.
6. **Accessibility:** Retain `/caffeinate` and Escape as keyboard stop
   controls and add a minimal standard D-Bus menu containing a labelled
   **Stop keeping awake** action for assistive/tray-menu users.
7. **Release:** npm Trusted Publishing is the only automated publish mechanism.
   No long-lived npm token is stored in GitHub. The local publish route remains
   an emergency operator procedure, not the release workflow.

## Scope

In scope:

- The `dbus-native` migration and its Node compatibility boundary.
- Lifecycle, structured diagnostics, D-Bus menu accessibility, tests, CI, npm
  metadata, release configuration, and release documentation.
- A `0.0.2` release after all verification gates pass.

Intentionally out of scope:

- macOS, Windows, non-systemd Linux, alternate awake backends, and a full KDE
  Plasma widget.
- A graphical configuration UI or a multi-action tray menu.
- Changing the published `0.0.1` artifact or its immutable provenance state.

## Tasks

- [x] **Task 1: Establish the new package/runtime contract.** Replace
  `dbus-next` with `dbus-native@^0.15.2`, set `engines.node` to `>=22.12.0`,
  change `author` to `NIMENDRA`, regenerate `package-lock.json`, and verify the
  packed artifact excludes test and planning files.
  **Files:** `package.json`, `package-lock.json`.
  **Seam:** npm metadata, lockfile, and `npm pack` file allowlist.
  **Verify:** `npm ci && npm audit --omit=dev && npm pack --dry-run`; inspect
  `npm view`-equivalent local metadata and assert the packed list contains only
  `package.json`, `README.md`, `LICENSE`, and the runtime `.ts` files.

- [x] **Task 2: Port the StatusNotifier transport to dbus-native.** Replace
  the `dbus-next` imports and interface-class implementation with
  `dbus-native`'s interface definition/service export API. Preserve exported
  KDE and freedesktop StatusNotifierItem interfaces at `/StatusNotifierItem`,
  the current properties/pixmaps, `Activate`, signals/property-change events,
  the `/Menu` property, and KDE-first/freedesktop-fallback watcher registration.
  Add a standard exported DBusMenu object and route its single
  `Stop keeping awake` item to `onActivate`.
  **Files:** `kde-status-notifier.ts`, `test/kde-status-notifier.test.ts`.
  **Seam:** `KdeStatusNotifierOptions.busFactory` and a transport-neutral fake
  bus/menu adapter.
  **Verify:** `npm run check && npm test`; in a KDE session, start Pi,
  `/caffeinate manual`, inspect the service with `qdbus6 --session`, confirm
  Plasma shows the icon and labelled menu action, and confirm both click and
  menu action stop the inhibitor.

- [x] **Task 3: Make inhibitor termination observable and correct.** Replace
  `terminateProcess()`'s nullable-timer return with a structured result that
  records whether SIGTERM was sent, whether escalation was scheduled, and any
  synchronous signal-delivery error or false-return failure. Have the session
  finalizer notify only when a user-initiated stop cannot signal the inhibitor;
  clear an escalation timer on child exit as it does today.
  **Files:** `linux-awake.ts`, `caffeinate.ts`, `test/linux-awake.test.ts`,
  `test/caffeinate.test.ts`.
  **Seam:** injected `ChildProcess.kill()` behavior.
  **Verify:** test successful TERM, failed `kill() === false`, thrown kill,
  exited child, and TERM-to-KILL escalation; run `npm run check && npm test`.

- [x] **Task 4: Harden host termination semantics.** Extract finalization into
  explicit awaited and synchronous phases. Register `SIGINT`/`SIGTERM` handlers
  that stop the active inhibitor and tray within a bounded cleanup interval,
  then restore/forward termination without recursive signal handling. Keep
  `session_shutdown` as the primary awaited Pi lifecycle path; make the `exit`
  handler perform only synchronous best-effort process signalling and status
  teardown.
  **Files:** `caffeinate.ts`, `test/caffeinate.test.ts`.
  **Seam:** `CaffeinateRuntime` gains injectable process-signal registration
  and timer functions so signal behavior is testable without terminating the
  test runner.
  **Verify:** tests assert each handler is registered once, cleanup is
  idempotent, the child is signalled once, and no rejected cleanup promise is
  produced; manually interrupt a Pi session with an active manual inhibitor and
  verify `systemd-inhibit --list` no longer lists `pi-caffeinated`.

- [x] **Task 5: Improve tray and inhibitor diagnostics.** Introduce typed
  diagnostic stages (`connect`, `claim-name`, `export`, `register-kde-watcher`,
  `register-freedesktop-watcher`, `update`, `release`) and format one concise
  UI warning with stage/cause while retaining non-fatal tray behavior. Add
  actionable inhibitor-exit text that directs users to `systemd-inhibit --list`
  and relevant session-bus checks.
  **Files:** `kde-status-notifier.ts`, `caffeinate.ts`, `README.md`,
  `test/kde-status-notifier.test.ts`, `test/caffeinate.test.ts`.
  **Seam:** notifier `onError` callback and fake bus failures at each phase.
  **Verify:** tests simulate both watcher failures, bus errors after startup,
  and property-update failures; assert one user warning contains its stage and
  the inhibitor/footer remains active.

- [x] **Task 6: Expand concurrency and end-to-end coverage.** Add deferred
  fake-bus/fake-tray tests for stop during watcher registration, bus failure
  during active use, repeated concurrent `start()`/`stop()`, and child exit
  while tray startup is pending. Add a Linux integration script that launches
  the actual `systemd-inhibit` command, checks it appears in
  `systemd-inhibit --list`, terminates it, and confirms it disappears; skip
  with an explicit reason if logind is unavailable in CI.
  **Files:** `test/kde-status-notifier.test.ts`, `test/caffeinate.test.ts`,
  `test/systemd-inhibit.integration.test.ts` (new), `package.json`.
  **Seam:** existing fake bus/child factories and the exported
  `LINUX_AWAKE_COMMAND`.
  **Verify:** `npm test`; run the integration test on a systemd/logind Linux
  host and confirm no exported bus object, claimed name, status timer, or child
  survives each race.

- [x] **Task 7: Add a pull-request quality workflow.** Create a separate CI
  workflow for pull requests and pushes to `main` that uses Node 22.12+, runs
  `npm ci`, typecheck, tests, `npm pack --dry-run`, and a production audit gate.
  Keep the release workflow focused on release-please and publishing.
  **Files:** `.github/workflows/ci.yml` (new), `.github/workflows/release.yml`,
  `README.md`.
  **Seam:** GitHub Actions workflow commands and package scripts.
  **Verify:** `actionlint .github/workflows/*.yml`; inspect a successful GitHub
  Actions CI run for a branch/PR and confirm audit is zero for runtime deps.

- [ ] **Task 8: Configure and prove npm Trusted Publishing.** In npm package
  settings, create the GitHub Actions trusted publisher for repository
  `nmdra/pi-caffeinated-linux`, workflow `.github/workflows/release.yml`, and
  environment `main`/the default workflow context required by npm. Preserve
  `id-token: write` and `npm publish --provenance --access public`; do not add
  `NODE_AUTH_TOKEN`. Document the configuration and recovery procedure.
  **Files:** `.github/workflows/release.yml`, `README.md`,
  `.agents/plans/Plan.md`.
  **Seam:** npm package trusted-publisher configuration and the `publish` job.
  **Verify:** trigger the `0.0.2` release, confirm the publish job succeeds
  without npm credentials, then run
  `npm view @nimendra/pi-caffeinated-linux@0.0.2 dist.integrity --json`, inspect
  npm provenance, and install in a clean Pi profile with
  `pi install npm:@nimendra/pi-caffeinated-linux@0.0.2`.

- [ ] **Task 9: Release and document 0.0.2.** Update README requirements to
  Node 22.12+, document the tray menu and troubleshooting table, add release
  notes through release-please, merge the release PR, and verify installation
  plus the auto/manual lifecycle from the registry artifact.
  **Files:** `README.md`, `CHANGELOG.md` (release-please generated),
  `.release-please-manifest.json` (release-please generated).
  **Seam:** published npm package entry point and Pi command registration.
  **Verify:** clean-profile `pi install`, `pi list`, `/caffeinate` automatic
  stop at `agent_settled`, `/caffeinate manual` persistence, Escape/command/
  tray-menu stop, and `systemd-inhibit --list` before and after cleanup.

## Verification

1. `npm ci && npm run check && npm test` passes on Node 22.12+.
2. `npm audit --omit=dev` reports zero runtime vulnerabilities.
3. `npm pack --dry-run` includes only intended runtime/doc files and declares
   author `NIMENDRA`, Linux-only OS support, Node `>=22.12.0`, and
   `dbus-native`—not `dbus-next`.
4. On KDE, the service registers with a watcher, displays the pixmap/tooltip,
   and exposes both click and labelled menu stopping controls.
5. All cleanup paths leave no active systemd inhibitor, D-Bus name/export,
   footer status, terminal-input listener, or timer.
6. GitHub CI passes and the release job publishes `0.0.2` through OIDC with npm
   provenance. A clean Pi installation loads the package from npm.

## Open Questions

None. `dbus-native@^0.15.2` and Node `>=22.12.0` are approved for this release.
