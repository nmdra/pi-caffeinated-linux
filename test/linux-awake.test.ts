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
  assert.equal(isExecutableAvailable("systemd-inhibit", "/definitely-missing"), false);
});

test("formats shared awake status and elapsed time", () => {
  assert.equal(formatElapsed(START, START), "0s");
  assert.equal(formatElapsed(START, START + 62_000), "1m 2s");
  assert.equal(formatElapsed(START, START + 3_661_000), "1h 1m 1s");
  assert.equal(formatAwakeStatus(START, START + 12_000), "[awake] idle+sleep · 12s");
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
  const timer = terminateProcess(child as unknown as ChildProcess, 1);
  assert.ok(timer);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  clearTimeout(timer);
});
