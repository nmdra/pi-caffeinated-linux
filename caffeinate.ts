/** /caffeinate — keep a Linux machine awake with systemd-inhibit. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import {
  formatElapsed,
  formatTrayTooltip,
  isExecutableAvailable,
  LINUX_AWAKE_COMMAND,
  terminateProcess,
} from "./linux-awake.js";
import {
  KdeStatusNotifier,
  type KdeStatusNotifierOptions,
} from "./kde-status-notifier.js";

const STATUS_TICK_MS = 1000;
const STATUS_KEY = "caffeinate";

type StopReason =
  | "command"
  | "escape"
  | "tray"
  | "process-error"
  | "process-exit"
  | "session-shutdown"
  | "process-exit-hook";

type TrayIndicator = Pick<KdeStatusNotifier, "start" | "update" | "stop">;

export type CaffeinateRuntime = {
  spawnProcess?: typeof spawn;
  createTray?: (options: KdeStatusNotifierOptions) => TrayIndicator;
  registerProcessExit?: boolean;
};

type ActiveSession = {
  readonly context: ExtensionContext;
  readonly process: ChildProcess;
  readonly startTime: number;
  readonly tray: TrayIndicator;
  statusTimer: ReturnType<typeof setInterval> | null;
  forceKillTimer: ReturnType<typeof setTimeout> | null;
  unsubscribeEscape: (() => void) | null;
  cleanupPromise: Promise<void> | null;
  finalized: boolean;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldNotifyStop(reason: StopReason): boolean {
  return reason === "command" || reason === "escape" || reason === "tray";
}

function stopMessage(reason: StopReason): string {
  if (reason === "tray") return "Caffeinate stopped from the KDE tray";
  return "Caffeinate stopped";
}

function registerEscapeStop(
  session: ActiveSession,
  stop: (session: ActiveSession, reason: StopReason) => Promise<void>,
): void {
  if (!session.context.hasUI) return;
  session.unsubscribeEscape = session.context.ui.onTerminalInput((data) => {
    if (session.finalized || !matchesKey(data, "escape")) return;
    void stop(session, "escape");
    return { consume: true };
  });
}

function formatStyledAwakeStatus(
  context: ExtensionContext,
  startTime: number,
  now: number,
): string {
  const theme = context.ui.theme;
  return [
    theme.fg("accent", "\uec15"),
    theme.fg("success", "[awake]"),
    theme.fg("muted", "idle+sleep"),
    theme.fg("dim", `· ${formatElapsed(startTime, now)}`),
  ].join(" ");
}

type ExtensionRegistrationAPI = Pick<ExtensionAPI, "registerCommand" | "on">;

export function registerCaffeinate(
  pi: ExtensionRegistrationAPI,
  runtime: CaffeinateRuntime = {},
): void {
  let activeSession: ActiveSession | null = null;

  function updateIndicators(session: ActiveSession): void {
    if (session.finalized || activeSession !== session) return;

    const now = Date.now();
    session.context.ui.setStatus(
      STATUS_KEY,
      formatStyledAwakeStatus(session.context, session.startTime, now),
    );
    session.tray.update({
      tooltip: formatTrayTooltip(session.startTime, now),
      status: "Active",
    });
  }

  async function stopSession(
    session: ActiveSession,
    reason: StopReason,
  ): Promise<void> {
    if (session.cleanupPromise) return session.cleanupPromise;

    session.finalized = true;
    if (activeSession === session) activeSession = null;

    session.cleanupPromise = (async () => {
      if (session.statusTimer) {
        clearInterval(session.statusTimer);
        session.statusTimer = null;
      }
      if (session.forceKillTimer) {
        clearTimeout(session.forceKillTimer);
        session.forceKillTimer = null;
      }
      if (session.unsubscribeEscape) {
        session.unsubscribeEscape();
        session.unsubscribeEscape = null;
      }

      try {
        session.forceKillTimer = terminateProcess(session.process);
      } catch (error) {
        if (reason !== "process-exit" && reason !== "process-exit-hook") {
          session.context.ui.notify(
            `Could not stop systemd-inhibit: ${errorMessage(error)}`,
            "warning",
          );
        }
      }

      session.context.ui.setStatus(STATUS_KEY, undefined);
      try {
        await session.tray.stop();
      } catch (error) {
        reportTrayError(session.context, error);
      }

      if (shouldNotifyStop(reason)) {
        session.context.ui.notify(stopMessage(reason), "info");
      }
    })();

    return session.cleanupPromise;
  }

  function reportTrayError(context: ExtensionContext, error: unknown): void {
    if (!context.hasUI) return;
    context.ui.notify(
      `KDE tray indicator unavailable; caffeinate is still active (${errorMessage(error)})`,
      "warning",
    );
  }

  pi.registerCommand("caffeinate", {
    description: "Toggle Linux caffeinate (keeps your machine awake)",
    handler: async (_args, context) => {
      if (activeSession) {
        await stopSession(activeSession, "command");
        return;
      }

      if (!isExecutableAvailable(LINUX_AWAKE_COMMAND.cmd)) {
        context.ui.notify(
          `Could not find ${LINUX_AWAKE_COMMAND.cmd}; install systemd or use a systemd-based Linux session.`,
          "warning",
        );
        return;
      }

      let childProcess: ChildProcess;
      try {
        childProcess = (runtime.spawnProcess ?? spawn)(
          LINUX_AWAKE_COMMAND.cmd,
          LINUX_AWAKE_COMMAND.args,
          {
            stdio: "ignore",
            detached: false,
          },
        );
      } catch (error) {
        context.ui.notify(
          `Could not start ${LINUX_AWAKE_COMMAND.label}: ${errorMessage(error)}`,
          "warning",
        );
        return;
      }

      let session!: ActiveSession;
      const trayOptions: KdeStatusNotifierOptions = {
        onActivate: () => void stopSession(session, "tray"),
        onError: (error) => reportTrayError(context, error),
      };
      const tray =
        runtime.createTray?.(trayOptions) ?? new KdeStatusNotifier(trayOptions);
      session = {
        context,
        process: childProcess,
        startTime: Date.now(),
        tray,
        statusTimer: null,
        forceKillTimer: null,
        unsubscribeEscape: null,
        cleanupPromise: null,
        finalized: false,
      };
      activeSession = session;

      childProcess.on("error", (error) => {
        if (session.finalized) return;
        context.ui.notify(
          `Could not start ${LINUX_AWAKE_COMMAND.label}: ${error.message}`,
          "warning",
        );
        void stopSession(session, "process-error");
      });
      childProcess.on("exit", (code, signal) => {
        if (session.forceKillTimer) {
          clearTimeout(session.forceKillTimer);
          session.forceKillTimer = null;
        }
        if (session.finalized) return;

        if (code !== 0 && signal !== "SIGTERM") {
          context.ui.notify(
            `${LINUX_AWAKE_COMMAND.label} exited unexpectedly (${signal ?? `code ${code ?? "unknown"}`}).`,
            "warning",
          );
        }
        void stopSession(session, "process-exit");
      });

      session.statusTimer = setInterval(
        () => updateIndicators(session),
        STATUS_TICK_MS,
      );
      session.statusTimer.unref?.();
      updateIndicators(session);

      try {
        await session.tray.start();
      } catch (error) {
        reportTrayError(context, error);
      }
      if (session.finalized) {
        await session.tray.stop();
        return;
      }

      registerEscapeStop(session, stopSession);
    },
  });

  if (runtime.registerProcessExit !== false) {
    process.once("exit", () => {
      if (activeSession) void stopSession(activeSession, "process-exit-hook");
    });
  }

  pi.on("session_shutdown", async () => {
    if (activeSession) await stopSession(activeSession, "session-shutdown");
  });
}

export default function (pi: ExtensionAPI) {
  registerCaffeinate(pi);
}
