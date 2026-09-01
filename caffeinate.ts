/** /caffeinate — keep a Linux machine awake with systemd-inhibit. */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import {
  formatElapsed,
  formatTrayTooltip,
  isExecutableAvailable,
  LINUX_AWAKE_COMMAND,
  selectAwakeQuote,
  terminateProcess,
} from "./linux-awake.js";
import {
  KdeStatusNotifier,
  type KdeStatusNotifierDiagnostic,
  type KdeStatusNotifierOptions,
} from "./kde-status-notifier.js";

const STATUS_TICK_MS = 1000;
const STATUS_KEY = "caffeinate";

type SessionMode = "auto" | "manual";

type StopReason =
  | "command"
  | "escape"
  | "tray"
  | "agent-settled"
  | "process-error"
  | "process-exit"
  | "session-shutdown"
  | "process-signal"
  | "process-exit-hook";

type ProcessSignal = "SIGINT" | "SIGTERM";
type ProcessSignalHandler = () => void;
type TrayIndicator = Pick<KdeStatusNotifier, "start" | "update" | "stop">;

export type CaffeinateRuntime = {
  spawnProcess?: typeof spawn;
  createTray?: (options: KdeStatusNotifierOptions) => TrayIndicator;
  registerProcessExit?: boolean;
  registerProcessSignals?: boolean;
  registerSignal?: (
    signal: ProcessSignal,
    handler: ProcessSignalHandler,
  ) => void | (() => void);
  sendSignal?: (signal: ProcessSignal) => void;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  signalCleanupTimeoutMs?: number;
};

type ActiveSession = {
  readonly context: ExtensionContext;
  readonly process: ChildProcess;
  readonly processExitPromise: Promise<void>;
  readonly startTime: number;
  readonly quote: string;
  readonly mode: SessionMode;
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

function registerAgentSettled(
  pi: ExtensionRegistrationAPI,
  handler: () => Promise<void>,
): void {
  // Pi 0.84+ exposes agent_settled. Keep the source compatible with older
  // extension type packages while using the runtime event when available.
  // SAFETY: Pi 0.84+ provides this event; the local peer types may lag it.
  const on = pi.on as unknown as (
    event: "agent_settled",
    handler: () => Promise<void>,
  ) => void;
  on.call(pi, "agent_settled", handler);
}

function formatStyledAwakeStatus(
  context: ExtensionContext,
  startTime: number,
  now: number,
  quote: string,
): string {
  const theme = context.ui.theme;
  return [
    theme.fg("accent", "\uec15"),
    theme.fg("success", "[awake]"),
    theme.fg("muted", quote),
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
      formatStyledAwakeStatus(
        session.context,
        session.startTime,
        now,
        session.quote,
      ),
    );
    session.tray.update({
      tooltip: formatTrayTooltip(session.startTime, now),
      status: "Active",
    });
  }

  function prepareSessionStop(
    session: ActiveSession,
    reason: StopReason,
  ): void {
    if (session.finalized) return;

    session.finalized = true;
    if (activeSession === session) activeSession = null;

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

    const termination = terminateProcess(session.process, 500, {
      onError: (error) => {
        if (shouldNotifyStop(reason) && session.context.hasUI) {
          session.context.ui.notify(
            `Could not stop systemd-inhibit: ${errorMessage(error)}`,
            "warning",
          );
        }
      },
    });
    session.forceKillTimer = termination.forceKillTimer;
    session.context.ui.setStatus(STATUS_KEY, undefined);
  }

  function stopSessionSync(session: ActiveSession): void {
    prepareSessionStop(session, "process-exit-hook");
  }

  async function stopSession(
    session: ActiveSession,
    reason: StopReason,
  ): Promise<void> {
    if (session.cleanupPromise) return session.cleanupPromise;
    if (session.finalized) return;

    prepareSessionStop(session, reason);
    const cleanupPromise = (async () => {
      try {
        await session.tray.stop();
      } catch (error) {
        reportTrayError(session.context, error);
      }

      if (shouldNotifyStop(reason)) {
        session.context.ui.notify(stopMessage(reason), "info");
      }
    })();
    session.cleanupPromise = cleanupPromise;
    return cleanupPromise;
  }

  function reportTrayError(
    context: ExtensionContext,
    diagnosticOrError: KdeStatusNotifierDiagnostic | unknown,
  ): void {
    if (!context.hasUI) return;

    const isDiagnostic = (
      value: unknown,
    ): value is KdeStatusNotifierDiagnostic => {
      if (!value || typeof value !== "object") return false;
      // SAFETY: Object values with a string stage and error property are the
      // diagnostic shape emitted by KdeStatusNotifier.
      const candidate = value as Record<string, unknown>;
      return typeof candidate.stage === "string" && "error" in candidate;
    };
    const stage = isDiagnostic(diagnosticOrError)
      ? diagnosticOrError.stage
      : "connect";
    const error = isDiagnostic(diagnosticOrError)
      ? diagnosticOrError.error
      : diagnosticOrError;
    context.ui.notify(
      `KDE tray indicator unavailable (${stage}: ${errorMessage(error)}); caffeinate is still active`,
      "warning",
    );
  }

  pi.registerCommand("caffeinate", {
    description:
      "Keep Linux awake until Pi settles; use /caffeinate manual for persistent mode",
    handler: async (_args, context) => {
      const modeArg = _args.trim().toLowerCase();
      if (modeArg !== "" && modeArg !== "auto" && modeArg !== "manual") {
        context.ui.notify("Usage: /caffeinate [auto|manual]", "warning");
        return;
      }
      const mode: SessionMode = modeArg === "manual" ? "manual" : "auto";

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
      const processExitPromise = new Promise<void>((resolve) => {
        childProcess.once("exit", () => resolve());
        childProcess.once("error", () => resolve());
      });
      const trayOptions: KdeStatusNotifierOptions = {
        onActivate: () => void stopSession(session, "tray"),
        onError: (error) => reportTrayError(context, error),
      };
      const tray =
        runtime.createTray?.(trayOptions) ?? new KdeStatusNotifier(trayOptions);
      session = {
        context,
        process: childProcess,
        processExitPromise,
        startTime: Date.now(),
        quote: selectAwakeQuote(),
        mode,
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
            `${LINUX_AWAKE_COMMAND.label} exited unexpectedly (${signal ?? `code ${code ?? "unknown"}`}). Check systemd-inhibit --list.`,
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
      if (session.finalized) return;

      registerEscapeStop(session, stopSession);
    },
  });

  registerAgentSettled(pi, async () => {
    if (activeSession?.mode === "auto") {
      await stopSession(activeSession, "agent-settled");
    }
  });

  const registerSignal =
    runtime.registerSignal ??
    ((signal: ProcessSignal, handler: ProcessSignalHandler): void => {
      process.once(signal, handler);
    });
  const sendSignal =
    runtime.sendSignal ??
    ((signal: ProcessSignal): void => {
      process.kill(process.pid, signal);
    });
  const scheduleTimeout = runtime.setTimeout ?? setTimeout;
  const cancelTimeout = runtime.clearTimeout ?? clearTimeout;
  const signalCleanupTimeoutMs = runtime.signalCleanupTimeoutMs ?? 1_000;
  let signalCleanupPromise: Promise<void> | null = null;

  async function awaitBoundedCleanup(cleanup: Promise<void>): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<void>((resolve) => {
      timeout = scheduleTimeout(resolve, signalCleanupTimeoutMs);
    });
    await Promise.race([cleanup.catch(() => undefined), deadline]);
    if (timeout) cancelTimeout(timeout);
  }

  function handleProcessSignal(signal: ProcessSignal): void {
    if (signalCleanupPromise) return;

    const session = activeSession;
    signalCleanupPromise = (async () => {
      if (session) {
        const cleanup = Promise.all([
          stopSession(session, "process-signal"),
          session.processExitPromise,
        ]).then(() => undefined);
        await awaitBoundedCleanup(cleanup);
      }
      sendSignal(signal);
    })();
    void signalCleanupPromise.catch(() => {
      // The original signal was already received. There is no safe async
      // cleanup left to perform if forwarding the termination also fails.
    });
  }

  if (
    runtime.registerProcessSignals === true ||
    runtime.registerProcessExit !== false
  ) {
    registerSignal("SIGINT", () => handleProcessSignal("SIGINT"));
    registerSignal("SIGTERM", () => handleProcessSignal("SIGTERM"));
  }

  if (runtime.registerProcessExit !== false) {
    process.once("exit", () => {
      if (activeSession) stopSessionSync(activeSession);
    });
  }

  pi.on("session_shutdown", async () => {
    if (activeSession) await stopSession(activeSession, "session-shutdown");
  });
}

export default function (pi: ExtensionAPI) {
  registerCaffeinate(pi);
}
