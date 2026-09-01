import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCaffeinate, type CaffeinateRuntime } from "../caffeinate.js";
import type { KdeStatusNotifierOptions } from "../kde-status-notifier.js";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: (NodeJS.Signals | undefined)[] = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    this.signalCode = signal ?? "SIGTERM";
    this.emit("exit", null, this.signalCode);
    return true;
  }
}

class FakeTray {
  readonly options: KdeStatusNotifierOptions;
  startCount = 0;
  stopCount = 0;
  updates: unknown[] = [];

  constructor(options: KdeStatusNotifierOptions) {
    this.options = options;
  }

  async start(): Promise<boolean> {
    this.startCount++;
    return true;
  }

  update(update: unknown): void {
    this.updates.push(update);
  }

  async stop(): Promise<void> {
    this.stopCount++;
  }
}

class DeferredTray extends FakeTray {
  private resolveStart?: () => void;

  override async start(): Promise<boolean> {
    this.startCount++;
    await new Promise<void>((resolve) => {
      this.resolveStart = resolve;
    });
    return true;
  }

  resolvePendingStart(): void {
    this.resolveStart?.();
    this.resolveStart = undefined;
  }
}

function createContext() {
  const statuses: (string | undefined)[] = [];
  const notices: string[] = [];
  let escapeHandler:
    | ((data: string) => { consume?: boolean } | undefined)
    | undefined;
  const context = {
    hasUI: true,
    ui: {
      setStatus: (_key: string, value: string | undefined) =>
        statuses.push(value),
      notify: (message: string) => notices.push(message),
      theme: {
        fg: (_color: string, text: string) => text,
      },
      onTerminalInput: (handler: typeof escapeHandler) => {
        escapeHandler = handler;
        return () => {
          escapeHandler = undefined;
        };
      },
    },
  } as unknown as ExtensionContext;

  return {
    context,
    statuses,
    notices,
    get escapeHandler() {
      return escapeHandler;
    },
  };
}

function createPi(
  onCommand: (
    handler: (_args: string, context: ExtensionContext) => Promise<void>,
  ) => void,
  onShutdown?: (handler: () => Promise<void>) => void,
  onAgentSettled?: (handler: () => Promise<void>) => void,
) {
  return {
    registerCommand: (
      _name: string,
      definition: {
        handler: (_args: string, context: ExtensionContext) => Promise<void>;
      },
    ) => onCommand(definition.handler),
    on: (event: string, handler: () => Promise<void>) => {
      if (event === "session_shutdown") onShutdown?.(handler);
      if (event === "agent_settled") onAgentSettled?.(handler);
    },
  } as never;
}

function createRuntime(child: FakeChild, tray: FakeTray): CaffeinateRuntime {
  return {
    spawnProcess: (() => child as unknown as ChildProcess) as never,
    createTray: () => tray,
    registerProcessExit: false,
  };
}

test("keeps the colored footer and tray synchronized across command stop", async () => {
  let commandHandler:
    | ((_args: string, context: ExtensionContext) => Promise<void>)
    | undefined;
  let shutdownHandler: (() => Promise<void>) | undefined;
  const child = new FakeChild();
  const tray = new FakeTray({});
  const pi = createPi(
    (handler) => {
      commandHandler = handler;
    },
    (handler) => {
      shutdownHandler = handler;
    },
  );
  const view = createContext();
  registerCaffeinate(pi, createRuntime(child, tray));
  assert.ok(commandHandler);

  const startPromise = commandHandler!("", view.context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.statuses.at(-1)?.startsWith("\uec15 [awake] "), true);
  assert.equal(tray.startCount, 1);

  await commandHandler!("", view.context);
  await startPromise;
  assert.equal(view.statuses.at(-1), undefined);
  assert.equal(tray.stopCount, 1);
  assert.deepEqual(child.signals, ["SIGTERM"]);

  await shutdownHandler!();
  assert.equal(tray.stopCount, 1);
});

test("auto mode stops when the agent settles", async () => {
  let commandHandler:
    | ((_args: string, context: ExtensionContext) => Promise<void>)
    | undefined;
  let settledHandler: (() => Promise<void>) | undefined;
  const child = new FakeChild();
  const tray = new FakeTray({});
  const pi = createPi(
    (handler) => {
      commandHandler = handler;
    },
    undefined,
    (handler) => {
      settledHandler = handler;
    },
  );
  const view = createContext();
  registerCaffeinate(pi, createRuntime(child, tray));

  const startPromise = commandHandler!("", view.context);
  await new Promise((resolve) => setImmediate(resolve));
  await settledHandler!();
  await startPromise;

  assert.equal(tray.stopCount, 1);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(view.statuses.at(-1), undefined);
});

test("manual mode remains active after the agent settles", async () => {
  let commandHandler:
    | ((_args: string, context: ExtensionContext) => Promise<void>)
    | undefined;
  let settledHandler: (() => Promise<void>) | undefined;
  const child = new FakeChild();
  const tray = new FakeTray({});
  const pi = createPi(
    (handler) => {
      commandHandler = handler;
    },
    undefined,
    (handler) => {
      settledHandler = handler;
    },
  );
  const view = createContext();
  registerCaffeinate(pi, createRuntime(child, tray));

  const startPromise = commandHandler!("manual", view.context);
  await new Promise((resolve) => setImmediate(resolve));
  await settledHandler!();
  assert.equal(tray.stopCount, 0);
  assert.ok(view.statuses.at(-1)?.includes("[awake]"));

  await commandHandler!("", view.context);
  await startPromise;
  assert.equal(tray.stopCount, 1);
});

test("Escape stops the active session and consumes the key", async () => {
  let commandHandler:
    | ((_args: string, context: ExtensionContext) => Promise<void>)
    | undefined;
  const child = new FakeChild();
  const tray = new FakeTray({});
  const pi = createPi((handler) => {
    commandHandler = handler;
  });
  const view = createContext();
  registerCaffeinate(pi, createRuntime(child, tray));
  const startPromise = commandHandler!("", view.context);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(view.escapeHandler?.("\u001b")?.consume, true);
  await startPromise;
  assert.equal(tray.stopCount, 1);
});

test("cleans up the footer and tray when systemd-inhibit exits", async () => {
  let commandHandler:
    | ((_args: string, context: ExtensionContext) => Promise<void>)
    | undefined;
  const child = new FakeChild();
  const tray = new FakeTray({});
  const pi = createPi((handler) => {
    commandHandler = handler;
  });
  const view = createContext();
  registerCaffeinate(pi, createRuntime(child, tray));

  const startPromise = commandHandler!("", view.context);
  await new Promise((resolve) => setImmediate(resolve));
  child.exitCode = 1;
  child.emit("exit", 1, null);

  await startPromise;
  assert.equal(view.statuses.at(-1), undefined);
  assert.equal(tray.stopCount, 1);
  assert.ok(
    view.notices.some((notice) => notice.includes("exited unexpectedly")),
  );
});

test("stops and cleans up when the session shuts down", async () => {
  let commandHandler:
    | ((_args: string, context: ExtensionContext) => Promise<void>)
    | undefined;
  let shutdownHandler: (() => Promise<void>) | undefined;
  const child = new FakeChild();
  const tray = new FakeTray({});
  const pi = createPi(
    (handler) => {
      commandHandler = handler;
    },
    (handler) => {
      shutdownHandler = handler;
    },
  );
  const view = createContext();
  registerCaffeinate(pi, createRuntime(child, tray));

  const startPromise = commandHandler!("", view.context);
  await new Promise((resolve) => setImmediate(resolve));
  await shutdownHandler!();
  await startPromise;

  assert.equal(tray.stopCount, 1);
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("stops from tray activation", async () => {
  let commandHandler:
    | ((_args: string, context: ExtensionContext) => Promise<void>)
    | undefined;
  const child = new FakeChild();
  let tray: FakeTray | undefined;
  const pi = createPi((handler) => {
    commandHandler = handler;
  });
  const runtime: CaffeinateRuntime = {
    spawnProcess: (() => child as unknown as ChildProcess) as never,
    createTray: (options) => {
      tray = new FakeTray(options);
      return tray;
    },
    registerProcessExit: false,
  };
  const view = createContext();
  registerCaffeinate(pi, runtime);
  const startPromise = commandHandler!("", view.context);
  await new Promise((resolve) => setImmediate(resolve));

  await tray!.options.onActivate?.();
  await startPromise;
  assert.equal(tray!.stopCount, 1);
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("reports a termination failure for a user-initiated stop", async () => {
  let commandHandler:
    | ((_args: string, context: ExtensionContext) => Promise<void>)
    | undefined;
  class FailedChild extends EventEmitter {
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;

    kill(): boolean {
      return false;
    }
  }

  const child = new FailedChild();
  const tray = new FakeTray({});
  const pi = createPi((handler) => {
    commandHandler = handler;
  });
  const view = createContext();
  registerCaffeinate(pi, {
    spawnProcess: (() => child as unknown as ChildProcess) as never,
    createTray: () => tray,
    registerProcessExit: false,
  });

  const startPromise = commandHandler!("", view.context);
  await new Promise((resolve) => setImmediate(resolve));
  await commandHandler!("", view.context);
  await startPromise;

  assert.ok(
    view.notices.some((notice) =>
      notice.includes("Could not stop systemd-inhibit"),
    ),
  );
  assert.equal(tray.stopCount, 1);
});

test("forwards a host termination signal after bounded cleanup", async () => {
  let commandHandler:
    | ((_args: string, context: ExtensionContext) => Promise<void>)
    | undefined;
  const child = new FakeChild();
  const tray = new FakeTray({});
  const handlers: Record<string, () => void> = {};
  const forwarded: string[] = [];
  const pi = createPi((handler) => {
    commandHandler = handler;
  });
  const view = createContext();
  registerCaffeinate(pi, {
    ...createRuntime(child, tray),
    registerProcessSignals: true,
    registerSignal: (signal, handler) => {
      handlers[signal] = handler;
    },
    sendSignal: (signal) => {
      forwarded.push(signal);
    },
  });

  const startPromise = commandHandler!("manual", view.context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(handlers.SIGTERM);
  assert.ok(handlers.SIGINT);

  handlers.SIGTERM!();
  handlers.SIGTERM!();
  await new Promise((resolve) => setImmediate(resolve));
  await startPromise;

  assert.deepEqual(forwarded, ["SIGTERM"]);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(tray.stopCount, 1);
  assert.equal(view.statuses.at(-1), undefined);
});

test("waits for force-kill before forwarding a host signal", async () => {
  let commandHandler:
    | ((_args: string, context: ExtensionContext) => Promise<void>)
    | undefined;
  class StubbornChild extends EventEmitter {
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    signals: (NodeJS.Signals | undefined)[] = [];

    kill(signal?: NodeJS.Signals): boolean {
      this.signals.push(signal);
      if (signal === "SIGKILL") {
        this.signalCode = signal;
        this.emit("exit", null, signal);
      }
      return true;
    }
  }

  const child = new StubbornChild();
  const tray = new FakeTray({});
  const handlers: Record<string, () => void> = {};
  const forwarded: string[] = [];
  const pi = createPi((handler) => {
    commandHandler = handler;
  });
  const view = createContext();
  registerCaffeinate(pi, {
    spawnProcess: (() => child as unknown as ChildProcess) as never,
    createTray: () => tray,
    registerProcessExit: false,
    registerProcessSignals: true,
    registerSignal: (signal, handler) => {
      handlers[signal] = handler;
    },
    sendSignal: (signal) => forwarded.push(signal),
  });

  const startPromise = commandHandler!("manual", view.context);
  await new Promise((resolve) => setImmediate(resolve));
  handlers.SIGTERM!();
  for (let attempt = 0; attempt < 20 && forwarded.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await startPromise;

  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(forwarded, ["SIGTERM"]);
  assert.equal(tray.stopCount, 1);
});

test("cleans up when the inhibitor exits during tray startup", async () => {
  let commandHandler:
    | ((_args: string, context: ExtensionContext) => Promise<void>)
    | undefined;
  const child = new FakeChild();
  const tray = new DeferredTray({});
  const pi = createPi((handler) => {
    commandHandler = handler;
  });
  const view = createContext();
  registerCaffeinate(pi, {
    spawnProcess: (() => child as unknown as ChildProcess) as never,
    createTray: () => tray,
    registerProcessExit: false,
  });

  const startPromise = commandHandler!("", view.context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tray.startCount, 1);
  child.exitCode = 1;
  child.emit("exit", 1, null);
  assert.equal(tray.stopCount, 1);

  tray.resolvePendingStart();
  await startPromise;
  assert.equal(view.statuses.at(-1), undefined);
});

test("reports a spawn failure without creating an active session", async () => {
  let commandHandler:
    | ((_args: string, context: ExtensionContext) => Promise<void>)
    | undefined;
  const pi = createPi((handler) => {
    commandHandler = handler;
  });
  const runtime: CaffeinateRuntime = {
    spawnProcess: (() => {
      throw new Error("spawn failed");
    }) as never,
    registerProcessExit: false,
  };
  const view = createContext();
  registerCaffeinate(pi, runtime);

  await commandHandler!("", view.context);
  assert.ok(view.notices.some((notice) => notice.includes("Could not start")));
  assert.equal(view.statuses.length, 0);
});
