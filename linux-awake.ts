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

/**
 * Ask an active child process to exit and escalate if it does not respond.
 * The caller owns the returned timer and should clear it when the child exits.
 */
export function terminateProcess(
  proc: ChildProcess,
  forceAfterMs = 500,
): ReturnType<typeof setTimeout> | null {
  if (proc.exitCode !== null || proc.signalCode !== null) return null;

  proc.kill("SIGTERM");
  if (proc.exitCode !== null || proc.signalCode !== null) return null;

  const forceKill = setTimeout(() => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill("SIGKILL");
  }, forceAfterMs);
  forceKill.unref?.();
  return forceKill;
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

export function formatAwakeStatus(startTime: number, now = Date.now()): string {
  return `[awake] idle+sleep · ${formatElapsed(startTime, now)}`;
}

export function formatTrayTooltip(
  startTime: number,
  now = Date.now(),
): string {
  return `Awake · idle and sleep blocked · ${formatElapsed(startTime, now)}`;
}
