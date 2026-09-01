# Plan: Linux-only caffeinate with Pi and KDE indicators

## Goal

Turn this fork into a Linux-only Pi extension that keeps the machine awake with
`systemd-inhibit`, reports the exact inhibited state in Pi, replaces the large
modal with a tiny animated ASCII coffee cup in Pi's top-right corner, and
publishes an active KDE-compatible session-bus tray item. The inhibitor, Pi
status, Pi indicator, and tray item must start and stop together.

## Current State

- `caffeinate.ts:getAwakeCommand()` currently defines macOS, Linux, Windows, and
  unsupported-platform branches (`caffeinate.ts:49-95`). The Linux command is
  already `systemd-inhibit --what=idle:sleep ... sleep infinity`
  (`caffeinate.ts:58-71`).
- `isExecutableAvailable()` contains Windows-only `PATHEXT` and extension logic
  (`caffeinate.ts:97-118`), and `kill()` has separate Windows signal paths
  (`caffeinate.ts:413-434`).
- The command currently creates a large centered, input-capturing custom overlay
  (`caffeinate.ts:491-516`). `CaffeinateComponent` owns the animated artwork and
  timer (`caffeinate.ts:201-405`).
- The current footer status is only `"☕ caffeinated"` and is cleared from some
  process/error/close paths (`caffeinate.ts:473-500`); it does not show elapsed
  time or whether `idle` and `sleep` are inhibited.
- Process-exit/error handlers clear process state but do not consistently close
  the custom UI or dispose its timer (`caffeinate.ts:473-487`). The custom UI
  completion path also only nulls `activeComponent` after returning
  (`caffeinate.ts:517`). The refactor must make all shutdown paths idempotent.
- `package.json` describes a cross-platform extension, contains `macos` and
  `windows` keywords, has no Linux package restriction, and ships only
  `caffeinate.ts` (`package.json:4-15`, `package.json:32-50`).
- `README.md` documents macOS, Linux, and Windows backends and shows the old
  centered-modal behavior (`README.md:5-24`, `README.md:42-47`). There is no test
  directory or test script.
- Planning-time host checks found `XDG_CURRENT_DESKTOP=KDE`,
  `/usr/bin/systemd-inhibit`, `/usr/bin/systemctl`, and `/usr/bin/qdbus6`.
  The session bus currently exposes `org.kde.StatusNotifierWatcher` and a
  `org.kde.StatusNotifierHost`, so KDE StatusNotifierItem integration is
  testable on this host.

External constraints and evidence:

- systemd defines `idle` and `sleep` inhibitor types and documents
  `systemd-inhibit --list` plus the `Inhibit()`/`ListInhibitors()` model:
  <https://systemd.io/INHIBITOR_LOCKS/>
  and <https://freedesktop.org/software/systemd/man/latest/systemd-inhibit.html>.
- Pi's TUI supports custom components whose rendered lines must fit the supplied
  width, and overlay options include `anchor: "top-right"`, margins, dynamic
  sizing, and `nonCapturing`:
  <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/tui.md>
  and <https://github.com/badlogic/pi-mono/blob/main/packages/tui/README.md>.
- Pi's extension API supports persistent footer status, raw terminal-input
  listeners, and custom UI components; custom components are appropriate for
  TUI mode, while status APIs can be used independently:
  <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md>
  and <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/extensions/types.ts>.
- The StatusNotifierItem specification defines `Status`, `IconName`,
  `IconPixmap`, `ToolTip`, activation methods, and update signals; the watcher
  requires `RegisterStatusNotifierItem`:
  <https://specifications.freedesktop.org/status-notifier-item/latest/status-notifier-item.html>
  and <https://freedesktop.org/wiki/Specifications/StatusNotifierItem/StatusNotifierWatcher/>.
- KDE Plasma consumes both `org.kde.StatusNotifierItem` and
  `org.freedesktop.StatusNotifierItem` properties/methods and understands the
  no-menu sentinel used by Plasma:
  <https://github.com/KDE/plasma-workspace/blob/master/applets/systemtray/statusnotifieritemsource.cpp>.
- `dbus-next` provides Node session-bus clients/services, `requestName()`,
  `export()`, `unexport()`, and typed D-Bus interfaces:
  <https://github.com/dbusjs/node-dbus-next>.

## Decisions

1. **Linux backend:** Keep only the systemd-based Linux backend and describe
   failure to find `systemd-inhibit` clearly. Remove macOS, Windows, and
   generic unsupported-platform branches from source rather than retaining
   dead compatibility code. Add the npm `os: ["linux"]` declaration. Non-systemd
   Linux remains unsupported and must fail with an actionable warning.
2. **Pi placement:** Use a `nonCapturing` custom overlay anchored at
   `top-right`, with a fixed small width and one short ASCII cup frame. This is
   the only supported Pi UI primitive that places a persistent animated item at
   that corner without replacing the editor/footer. Preserve Escape-to-stop with
   a temporary `ctx.ui.onTerminalInput()` listener because a non-capturing
   overlay does not receive keyboard focus; the normal `/caffeinate` command
   remains a second stop control.
3. **Pi status text:** Replace the ambiguous static label with the exact live
   status `[awake] idle+sleep · <elapsed>`. Update it from the same active-session
   clock as the cup and clear it on every stop/error/shutdown path.
4. **KDE tray protocol:** Implement a small `KdeStatusNotifier` using
   `dbus-next` on the user session bus. Export one `/StatusNotifierItem` object
   with both `org.kde.StatusNotifierItem` and
   `org.freedesktop.StatusNotifierItem` interfaces, register it with the KDE
   watcher first and the freedesktop watcher as fallback, and use
   `Status=Active`, `Category=SystemServices`, a stable ID/title, an icon name
   plus a small `IconPixmap` fallback, and a tooltip containing the inhibited
   state and elapsed time. Left-click activation stops caffeinate. No DBusMenu
   dependency is needed; `ContextMenu` is a no-op and `Menu` uses Plasma's
   `/NO_DBUSMENU` convention.
5. **Graceful degradation:** Failure to connect to a session bus, find a
   watcher, claim the item name, or update the tray must never stop the
   systemd inhibitor or break the Pi indicator/status. Report tray-unavailable
   once in interactive mode and continue. Do not call KDE's private PowerDevil
   policy API; the standard StatusNotifierItem protocol is the desktop-facing
   contract, while `systemd-inhibit --list` remains the diagnostic source of
   truth.
6. **Lifecycle contract:** Centralize stop/finalization so command toggle,
   Escape, tray activation, child `error`, child `exit`, custom-overlay close,
   session shutdown, and process exit all converge on one idempotent cleanup
   path. The path must dispose timers/listeners, resolve the custom UI exactly
   once, release the tray item, clear status, and terminate the child without
   duplicate signals.

## Scope

In scope:

- Linux-only source, package metadata, README, and generated lockfile updates.
- `systemd-inhibit` availability/error handling and accurate `idle+sleep`
  wording.
- A small animated Pi TUI indicator in the top-right and a live Pi footer
  status.
- KDE/freedesktop StatusNotifierItem registration, tooltip, icon fallback,
  click-to-stop, and cleanup.
- Unit/integration seams for backend arguments, rendering, lifecycle, and D-Bus
  behavior, plus live KDE verification commands.

Intentionally out of scope:

- Supporting macOS, Windows, non-systemd Linux, or a second keep-awake backend.
- A Plasma widget, PowerDevil plugin, desktop notification daemon integration,
  or a full DBusMenu context menu.
- Renaming the npm package or changing fork ownership/provenance URLs.
- Manually deleting transitive macOS/Windows optional packages from
  `package-lock.json`; those are owned by Pi's upstream dependency graph. The
  source-owned runtime and npm metadata will contain no cross-platform support,
  and Linux installs will be verified separately.

## Tasks

- [x] **Task 1: Define the Linux package/runtime contract.** Move `dbus-next`
  to production `dependencies`, add `os: ["linux"]`, remove cross-platform
  keywords, include the new runtime modules in the published `files` list, and
  regenerate the lockfile rather than hand-editing transitive entries.
  **Files:** `package.json`, `package-lock.json`.
  **Seam:** npm package metadata and dependency installation.
  **Verify:** `npm install --package-lock-only`; `npm pack --dry-run`; inspect
  the packed file list and root lock metadata; confirm `dbus-next` is a runtime
  dependency and `os` is Linux-only.

- [x] **Task 2: Isolate the Linux inhibitor backend.** Create a Linux-only
  backend module exporting the fixed `systemd-inhibit` command, its accurate
  user-facing description, POSIX `PATH` lookup, and SIGTERM/SIGKILL cleanup.
  Remove `darwin`, `win32`, PowerShell, `PATHEXT`, Windows path extension, and
  unsupported-platform branches from `caffeinate.ts`. Keep the command args
  exactly `--what=idle:sleep`, `--who=pi-caffeinated`, `--why=Keeping the machine
  awake from Pi`, `--mode=block`, `sleep`, `infinity`.
  **Files:** `linux-awake.ts` (new), `caffeinate.ts`.
  **Seam:** exported command configuration and injected child-process
  lifecycle.
  **Verify:** unit-test the exact command/args and missing/executable `PATH`
  cases; `grep` source and README for `darwin`, `win32`, `powershell`, and
  `PATHEXT`; `npm run check`.

- [x] **Task 3: Keep the Pi UI compact and non-blocking.** Remove the large
  modal and the later overlay animation entirely. Keep Escape available through
  the raw terminal-input listener, and render the colored awake message in the
  persistent Pi footer instead of a custom component.
  **Files:** `caffeinate.ts`, removed `pi-indicator.ts`.
  **Seam:** `ctx.ui.setStatus()` plus the existing Escape listener.
  **Verify:** confirm the footer fits normal terminal widths and the editor is
  never replaced or covered by an overlay.

- [x] **Task 4: Add the KDE StatusNotifierItem service.** Implement
  `KdeStatusNotifier` with a bus adapter seam. Lazily connect to the session
  bus on activation, claim a unique
  `org.freedesktop.StatusNotifierItem-<pid>-1` name, export
  `/StatusNotifierItem` under both KDE and freedesktop item interfaces, and
  register with `org.kde.StatusNotifierWatcher` or the freedesktop watcher
  fallback. Expose `Id`, `Title`, `Category`, `Status`, `IconName`, an
  `a(iiay)` pixmap fallback, `ToolTip`, `Menu=/NO_DBUSMENU`, and the required
  activation/context/scroll methods and update signals. Emit tooltip/status
  changes only when their values change. Wire `Activate` to the shared stop
  callback; make all D-Bus failures non-fatal.
  **Files:** `kde-status-notifier.ts` (new), `package.json`,
  `package-lock.json`.
  **Seam:** `KdeStatusNotifier` lifecycle plus injected session-bus adapter.
  **Verify:** unit-test registration, property values, changed-property
  signals, activation, and idempotent release using a fake adapter; on KDE,
  use `qdbus6 --session`/`qdbus6 --literal` to inspect the registered service
  and verify it appears in the Plasma tray.

- [x] **Task 5: Wire one active-session state machine to all indicators.** Refactor
  the command handler around one active state containing the child process,
  start time, mode (`auto` or `manual`), Escape-listener unsubscribe, and tray
  instance. Set the colored awake status immediately after spawn, update the
  footer and tray tooltip from the shared clock, and clear everything through
  one idempotent finalizer. Make `/caffeinate` default to auto cleanup at
  `agent_settled`; keep `/caffeinate manual` persistent until an explicit stop.
  Preserve Escape, tray activation, process error/exit, session shutdown, and
  host process exit semantics without TUI-only custom components.
  **Files:** `caffeinate.ts`, `kde-status-notifier.ts`.
  **Seam:** command handler with mocked `spawn()` and mocked `ctx.ui`/D-Bus
  adapter.
  **Verify:** integration tests cover auto settle, manual persistence, second-
  command stop, Escape stop, tray-click stop, unexpected child exit, spawn
  error, and session shutdown; confirm each path calls cleanup once and leaves
  no status, listener, timer, process, or bus export behind.

- [x] **Task 6: Add automated checks and test commands.** Add a lightweight
  TypeScript test runner and tests for Linux backend configuration, elapsed/status
  formatting, colored footer behavior, D-Bus contract, and lifecycle cleanup.
  Keep tests independent of a real KDE session bus; reserve the live tray check
  for the verification procedure.
  **Files:** `test/linux-awake.test.ts` (new),
  `test/kde-status-notifier.test.ts` (new), `test/caffeinate.test.ts` (new),
  `package.json`, `package-lock.json`.
  **Seam:** public pure helpers, fake child process, fake UI, and fake D-Bus
  transport.
  **Verify:** `npm run check && npm test`; all tests pass without KDE or
  `systemd-inhibit` mocks leaking into the host.

- [x] **Task 7: Rewrite documentation for Linux/KDE behavior.** Remove the old
  macOS/Windows table, stale centered-overlay screenshot and wording, and
  “one supported backend” language. Document the systemd requirement, exact
  `idle+sleep` semantics, automatic/manual modes, colored Pi footer status,
  Escape and command/tray stop controls, KDE session-bus tray behavior,
  graceful tray fallback, and diagnostics with `systemd-inhibit --list`.
  **Files:** `README.md`.
  **Seam:** user-visible install, usage, requirements, and troubleshooting
  documentation.
  **Verify:** read the rendered Markdown for consistency with package metadata;
  confirm every command and indicator described is covered by the automated or
  live verification steps.

## Verification

1. Run `npm install`, then `npm run check && npm test` from a clean checkout.
2. Run `npm pack --dry-run` and verify the package contains the Linux entrypoint
   and runtime modules, includes `dbus-next`, and does not advertise non-Linux
   support.
3. In this KDE session, load the extension in Pi and run `/caffeinate`:
   - Pi shows the colored ` [awake] idle+sleep · <elapsed>` footer status;
     automatic mode stops after `agent_settled`.
   - `systemd-inhibit --list` shows a `pi-caffeinated` block entry for
     `idle:sleep`.
   - `qdbus6 --session` shows the new StatusNotifierItem service, and Plasma
     shows the active tray item with the matching tooltip.
4. Confirm automatic mode stops at `agent_settled`; manual mode remains active.
   Confirm Escape, `/caffeinate`, and tray activation remove the Pi status,
   child process, and tray item, and that a second stop is harmless.
5. Kill or interrupt the inhibitor process and confirm Pi clears stale UI/state
   and reports a useful warning rather than leaving a timer or tray export.
6. Run the command in a session without a D-Bus watcher (for example under
   `dbus-run-session` without Plasma) and confirm the Linux inhibitor and Pi
   status still work while only the tray indicator is skipped.
7. Verify `session_shutdown` and Pi process exit release the inhibitor and bus
   name; `systemd-inhibit --list` must no longer contain the extension entry.

## Open Questions

None. The requested scope is both Pi-side indicators and KDE-compatible
StatusNotifierItem integration, with the existing systemd-based Linux backend.
