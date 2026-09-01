import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import {
  formatAwakeStatus,
  formatElapsed,
  formatTrayTooltip,
  isExecutableAvailable,
  LINUX_AWAKE_COMMAND,
  selectAwakeQuote,
  terminateProcess,
} from "../linux-awake.js";

const START = 1_700_000_000_000;

test("uses the Linux systemd-inhibit command", () => {
  assert.deepEqual(LINUX_AWAKE_COMMAND, {
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
  });
});

test("checks Linux PATH entries", () => {
  assert.equal(isExecutableAvailable("systemd-inhibit", "/bin:/usr/bin"), true);
  assert.equal(
    isExecutableAvailable("systemd-inhibit", "/definitely-missing"),
    false,
  );
});

test("formats shared awake status and elapsed time", () => {
  assert.equal(formatElapsed(START, START), "0s");
  assert.equal(formatElapsed(START, START + 62_000), "1m 2s");
  assert.equal(formatElapsed(START, START + 3_661_000), "1h 1m 1s");
  assert.equal(
    formatAwakeStatus(START, START + 12_000),
    "[awake] Sleep is overrated · 12s",
  );
  assert.equal(selectAwakeQuote(0), "Sleep is overrated");
  assert.equal(selectAwakeQuote(0.999999), "Caffeine beats hibernation");
  assert.equal(
    formatTrayTooltip(START, START + 12_000),
    "Awake · idle and sleep blocked · 12s",
  );
});

test("terminates a running child and escalates after the grace period", async () => {
  class FakeChild extends EventEmitter {
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    signals: (NodeJS.Signals | undefined)[] = [];

    kill(signal?: NodeJS.Signals): boolean {
      this.signals.push(signal);
      if (signal === "SIGKILL") this.signalCode = signal;
      return true;
    }
  }

  const child = new FakeChild();
  const result = terminateProcess(child as unknown as ChildProcess, 1);
  assert.equal(result.termSent, true);
  assert.equal(result.escalationScheduled, true);
  assert.ok(result.forceKillTimer);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  clearTimeout(result.forceKillTimer);
});

test("reports a failed termination signal without scheduling escalation", () => {
  class FailedChild extends EventEmitter {
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;

    kill(): boolean {
      return false;
    }
  }

  const result = terminateProcess(new FailedChild() as unknown as ChildProcess);
  assert.equal(result.termSent, false);
  assert.equal(result.escalationScheduled, false);
  assert.equal(result.forceKillTimer, null);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!.message, /SIGTERM/);
});

test("captures a synchronous termination error", () => {
  class ThrowingChild extends EventEmitter {
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;

    kill(): boolean {
      throw new Error("permission denied");
    }
  }

  const result = terminateProcess(
    new ThrowingChild() as unknown as ChildProcess,
  );
  assert.equal(result.termSent, false);
  assert.equal(result.escalationScheduled, false);
  assert.equal(result.forceKillTimer, null);
  assert.equal(result.errors[0]?.message, "permission denied");
});
