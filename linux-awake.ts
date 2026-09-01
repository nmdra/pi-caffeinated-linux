/** Linux systemd-inhibit backend and shared awake-session formatting. */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ChildProcess } from "node:child_process";

export type AwakeCommand = {
  cmd: string;
  args: string[];
  label: string;
  awakeMessage: string;
};

export const LINUX_AWAKE_COMMAND: AwakeCommand = {
  cmd: "systemd-inhibit",
  args: [
    "--what=idle:sleep",
    "--who=pi-caffeinated",
    "--why=Keeping the machine awake from Pi",
    "--mode=block",
    "sleep",
    "infinity",
  ],
  label: "systemd-inhibit",
  awakeMessage: "Idle and sleep are inhibited by systemd.",
};

export const AWAKE_QUOTES = [
  "Sleep is overrated",
  "The idle police lost",
  "Still brewing",
  "Your laptop is on duty",
  "Caffeine beats hibernation",
] as const;

/** Select one short status quote for the lifetime of an awake session. */
export function selectAwakeQuote(randomValue = Math.random()): string {
  const bounded = Math.max(0, Math.min(0.999999, randomValue));
  return AWAKE_QUOTES[Math.floor(bounded * AWAKE_QUOTES.length)]!;
}

/** Check whether a Linux command can be found on the supplied PATH. */
export function isExecutableAvailable(
  cmd: string,
  pathValue = process.env.PATH,
): boolean {
  if (!pathValue) return false;

  return pathValue.split(delimiter).some((directory) => {
    const candidate = join(directory, cmd);
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

export type ProcessTerminationResult = {
  termSent: boolean;
  escalationScheduled: boolean;
  forceKillTimer: ReturnType<typeof setTimeout> | null;
  errors: Error[];
};

export type TerminateProcessOptions = {
  onError?: (error: Error) => void;
};

function terminationError(signal: NodeJS.Signals, error?: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (error !== undefined) {
    return new Error(String(error));
  }
  return new Error(`Could not send ${signal} to systemd-inhibit`);
}

/**
 * Ask an active child process to exit and escalate if it does not respond.
 * Signal failures are returned instead of being mistaken for successful
 * cleanup. The caller owns the returned timer and should clear it on exit.
 */
export function terminateProcess(
  proc: ChildProcess,
  forceAfterMs = 500,
  options: TerminateProcessOptions = {},
): ProcessTerminationResult {
  const result: ProcessTerminationResult = {
    termSent: false,
    escalationScheduled: false,
    forceKillTimer: null,
    errors: [],
  };
  const reportError = (signal: NodeJS.Signals, error?: unknown): void => {
    const diagnostic = terminationError(signal, error);
    result.errors.push(diagnostic);
    options.onError?.(diagnostic);
  };

  if (proc.exitCode !== null || proc.signalCode !== null) return result;

  try {
    if (!proc.kill("SIGTERM")) {
      reportError("SIGTERM");
      return result;
    }
    result.termSent = true;
  } catch (error) {
    reportError("SIGTERM", error);
    return result;
  }
  if (proc.exitCode !== null || proc.signalCode !== null) return result;

  result.forceKillTimer = setTimeout(() => {
    result.forceKillTimer = null;
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      if (!proc.kill("SIGKILL")) reportError("SIGKILL");
    } catch (error) {
      reportError("SIGKILL", error);
    }
  }, forceAfterMs);
  result.escalationScheduled = true;
  result.forceKillTimer.unref?.();
  return result;
}

export function formatElapsed(startTime: number, now = Date.now()): string {
  const elapsed = Math.max(0, Math.floor((now - startTime) / 1000));
  const hrs = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);
  const secs = elapsed % 60;

  if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export function formatAwakeStatus(
  startTime: number,
  now = Date.now(),
  quote = AWAKE_QUOTES[0],
): string {
  return `[awake] ${quote} · ${formatElapsed(startTime, now)}`;
}

export function formatTrayTooltip(startTime: number, now = Date.now()): string {
  return `Awake · idle and sleep blocked · ${formatElapsed(startTime, now)}`;
}
