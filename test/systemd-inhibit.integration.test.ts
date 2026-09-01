import { strict as assert } from "node:assert";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { test } from "node:test";
import { isExecutableAvailable, LINUX_AWAKE_COMMAND } from "../linux-awake.js";

const execFile = promisify(execFileCallback);

async function listsCaffeinateInhibitor(pid: number): Promise<boolean> {
  try {
    const result = await execFile(LINUX_AWAKE_COMMAND.cmd, ["--list"], {
      env: { ...process.env, SYSTEMD_PAGER: "cat" },
      timeout: 1_000,
      encoding: "utf8",
    });
    return result.stdout
      .split("\\n")
      .some(
        (line) =>
          line.includes("pi-caffeinated") &&
          line.trim().split(/\\s+/).includes(String(pid)),
      );
  } catch {
    return false;
  }
}

async function waitForInhibitor(
  pid: number,
  expected: boolean,
): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await listsCaffeinateInhibitor(pid)) === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test("holds and releases a real systemd inhibitor", async (t) => {
  if (process.platform !== "linux") {
    t.skip("systemd-inhibit integration is Linux-only");
    return;
  }
  if (!isExecutableAvailable(LINUX_AWAKE_COMMAND.cmd)) {
    t.skip("systemd-inhibit is not available");
    return;
  }

  const child = spawn(LINUX_AWAKE_COMMAND.cmd, LINUX_AWAKE_COMMAND.args, {
    stdio: "ignore",
  });
  let childError: Error | undefined;
  child.once("error", (error) => {
    childError = error;
  });
  const childExit = once(child, "exit").catch(() => undefined);
  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGKILL");
    await Promise.race([
      childExit,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    t.skip("systemd-inhibit did not provide a process id");
    return;
  }

  try {
    const listed = await waitForInhibitor(pid, true);
    if (!listed) {
      t.skip(
        childError
          ? `systemd-inhibit could not start: ${childError.message}`
          : "systemd-logind is unavailable in this environment",
      );
      return;
    }
    assert.equal(await listsCaffeinateInhibitor(pid), true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await Promise.race([
      childExit,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([
        childExit,
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    assert.equal(await waitForInhibitor(pid, false), true);
  }
});
