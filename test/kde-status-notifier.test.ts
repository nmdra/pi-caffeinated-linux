import { strict as assert } from "node:assert";
import dbus, { Variant, toPlain } from "dbus-native";
import { test } from "node:test";
import {
  KdeStatusNotifier,
  formatStatusNotifierTooltip,
} from "../kde-status-notifier.js";

type DefinedExport = {
  path: string;
  iface: {
    name: string;
    impl: Record<string, unknown>;
  };
};

type PropertyChange = {
  path: string;
  interfaceName: string;
  changed: Record<string, unknown>;
};

class FakeBus {
  readonly exported: DefinedExport[] = [];
  readonly unexported: { path: string; iface?: unknown }[] = [];
  readonly propertyChanges: PropertyChange[] = [];
  readonly registrations: string[] = [];
  released = false;
  disconnected = false;
  failKdeWatcher = false;
  failFreedesktopWatcher = false;
  failPropertyChanges = false;
  deferRegistration = false;
  private releaseRegistration?: () => void;
  private errorListener?: (error: unknown) => void;

  async requestName(): Promise<number> {
    return 1;
  }

  async releaseName(): Promise<number> {
    this.released = true;
    return 1;
  }

  export(path: string, iface: DefinedExport["iface"]): void {
    this.exported.push({ path, iface });
    // dbus-native replaces the implementation's EventEmitter emit method on
    // export. Emulate that part so signal helpers are usable in this fake.
    iface.impl.emit = () => undefined;
  }

  emitPropertiesChanged(
    path: string,
    interfaceName: string,
    changed: Record<string, unknown>,
  ): void {
    if (this.failPropertyChanges) throw new Error("property update failed");
    this.propertyChanges.push({ path, interfaceName, changed });
  }

  on(event: "error", listener: (error: unknown) => void): void {
    if (event === "error") this.errorListener = listener;
  }

  removeListener(event: "error", listener: (error: unknown) => void): void {
    if (event === "error" && this.errorListener === listener) {
      this.errorListener = undefined;
    }
  }

  emitError(error: unknown): void {
    this.errorListener?.(error);
  }

  releaseWatcherRegistration(): void {
    this.releaseRegistration?.();
    this.releaseRegistration = undefined;
  }

  unexport(path: string, iface?: unknown): void {
    this.unexported.push({ path, iface });
  }

  async getInterface(
    name: string,
    _path: string,
    _interfaceName: string,
  ): Promise<{
    RegisterStatusNotifierItem: (service: string) => Promise<void>;
  }> {
    if (
      (this.failKdeWatcher && name === "org.kde.StatusNotifierWatcher") ||
      (this.failFreedesktopWatcher &&
        name === "org.freedesktop.StatusNotifierWatcher")
    ) {
      throw new Error(`${name} missing`);
    }
    return {
      RegisterStatusNotifierItem: async (service: string) => {
        if (this.deferRegistration) {
          await new Promise<void>((resolve) => {
            this.releaseRegistration = resolve;
          });
        }
        this.registrations.push(service);
      },
    };
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

test("registers both KDE and freedesktop tray interfaces", async () => {
  const bus = new FakeBus();
  let activated = 0;
  const notifier = new KdeStatusNotifier({
    pid: 1234,
    busFactory: () => bus as never,
    onActivate: () => {
      activated++;
    },
  });

  assert.equal(await notifier.start(), true);
  assert.equal(
    notifier.serviceName,
    "org.freedesktop.StatusNotifierItem-1234-1",
  );
  assert.deepEqual(bus.registrations, [notifier.serviceName]);
  assert.equal(bus.exported.length, 3);

  const item = bus.exported.find(({ path }) => path === "/StatusNotifierItem")!
    .iface.impl as {
    Status: string;
    Category: string;
    Id: string;
    IconName: string;
    ToolTip: [string, unknown[], string, string];
    Activate: (x: number, y: number, message?: unknown) => void;
  };
  assert.equal(item.Status, "Active");
  assert.equal(item.Category, "SystemServices");
  assert.equal(item.Id, "pi-caffeinated");
  assert.equal(item.IconName, "");
  assert.equal(item.ToolTip[3], formatStatusNotifierTooltip());
  assert.deepEqual(
    KdeStatusNotifier.COFFEE_ICON_PIXMAP.map(([width, height]) => [
      width,
      height,
    ]),
    [
      [16, 16],
      [22, 22],
      [24, 24],
      [32, 32],
    ],
  );
  for (const [width, height, pixels] of KdeStatusNotifier.COFFEE_ICON_PIXMAP) {
    assert.equal(pixels.length, width * height * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset] === 0) continue;
      assert.deepEqual(
        [...pixels.subarray(offset, offset + 4)],
        [255, 255, 255, 255],
      );
    }
  }
  const pixels24 = KdeStatusNotifier.COFFEE_ICON_PIXMAP[2]![2];
  const piTopOffset = (12 * 24 + 9) * 4;
  assert.deepEqual(
    [...pixels24.subarray(piTopOffset, piTopOffset + 4)],
    [255, 255, 255, 255],
  );
  item.Activate(0, 0, {});
  assert.equal(activated, 1);
  const menu = bus.exported.find(({ path }) => path === "/Menu")!.iface
    .impl as {
    GetLayout: (
      parentId: number,
      recursionDepth: number,
      propertyNames: string[],
      message?: unknown,
    ) => Promise<[number, unknown]>;
    GetGroupProperties: (
      ids: number[],
      propertyNames: string[],
      message?: unknown,
    ) => [number, Record<string, unknown>][];
    GetProperty: (
      id: number,
      name: string,
      message?: unknown,
    ) => Variant<string>;
    Event: (
      id: number,
      eventId: string,
      data: unknown,
      timestamp: number,
      message?: unknown,
    ) => null;
  };
  const [, layout] = await menu.GetLayout(0, -1, [], {});
  const menuLayout = layout as [
    number,
    Record<string, unknown>,
    Variant<[number, Record<string, Variant<string>>, unknown[]]>[],
  ];
  const childLayout = menuLayout[2][0];
  assert.ok(childLayout instanceof Variant);
  assert.equal(childLayout.value[1].label.value, "Stop keeping awake");
  const properties = menu.GetGroupProperties([1], ["label", "type"], {});
  assert.equal(
    (properties[0]?.[1]?.label as Variant<string>).value,
    "Stop keeping awake",
  );
  assert.equal(menu.GetProperty(1, "label", {})?.value, "Stop keeping awake");
  menu.Event(1, "clicked", {}, 0, {});
  assert.equal(activated, 2);
  notifier.setStatus("Passive");
  notifier.setStatus("Passive");
  assert.equal(notifier.status, "Passive");
  assert.equal(
    bus.propertyChanges.filter(({ changed }) => "Status" in changed).length,
    2,
  );

  notifier.setTooltip("first tooltip");
  notifier.setTooltip("first tooltip");
  assert.equal(
    bus.propertyChanges.filter(({ changed }) => "ToolTip" in changed).length,
    2,
  );

  notifier.update({ elapsed: "12s", inhibited: "idle+sleep" });
  assert.equal(item.ToolTip[3], "[awake] idle+sleep · 12s");

  await notifier.stop();
  assert.equal(bus.unexported.length, 2);
  assert.equal(bus.released, true);
  assert.equal(bus.disconnected, true);
});

test("falls back to the freedesktop watcher", async () => {
  const bus = new FakeBus();
  bus.failKdeWatcher = true;
  const notifier = new KdeStatusNotifier({ busFactory: () => bus });

  assert.equal(await notifier.start(), true);
  assert.deepEqual(bus.registrations, [notifier.serviceName]);
  await notifier.stop();
});

test("stop during name registration does not leave an exported item", async () => {
  const bus = new FakeBus();
  let resolveName!: (reply: number) => void;
  bus.requestName = () =>
    new Promise<number>((resolve) => {
      resolveName = resolve;
    });
  const notifier = new KdeStatusNotifier({ busFactory: () => bus as never });

  const startPromise = notifier.start();
  await new Promise((resolve) => setImmediate(resolve));
  const stopPromise = notifier.stop();
  resolveName(1);

  assert.equal(await startPromise, false);
  await stopPromise;
  assert.equal(bus.exported.length, 0);
  assert.equal(bus.unexported.length, 0);
  assert.equal(bus.released, false);
  assert.equal(bus.disconnected, true);
});

test("reports the failed watcher stage and cause once", async () => {
  const bus = new FakeBus();
  bus.failKdeWatcher = true;
  bus.failFreedesktopWatcher = true;
  const diagnostics: { stage: string; error: unknown }[] = [];
  const notifier = new KdeStatusNotifier({
    busFactory: () => bus,
    onError: (diagnostic) => diagnostics.push(diagnostic),
  });

  assert.equal(await notifier.start(), false);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.stage, "register-freedesktop-watcher");
  assert.match(
    String((diagnostics[0]?.error as Error).message),
    /StatusNotifierWatcher/,
  );
});

test("stops cleanly while watcher registration is pending", async () => {
  const bus = new FakeBus();
  bus.deferRegistration = true;
  const notifier = new KdeStatusNotifier({ busFactory: () => bus });

  const startPromise = notifier.start();
  await new Promise((resolve) => setImmediate(resolve));
  const stopPromise = notifier.stop();
  bus.releaseWatcherRegistration();

  assert.equal(await startPromise, false);
  await stopPromise;
  assert.equal(bus.unexported.length, 2);
  assert.equal(bus.released, true);
  assert.equal(bus.disconnected, true);
});

test("deduplicates concurrent start and stop calls", async () => {
  const bus = new FakeBus();
  const notifier = new KdeStatusNotifier({ busFactory: () => bus });

  const startPromise = notifier.start();
  assert.strictEqual(notifier.start(), startPromise);
  assert.equal(await startPromise, true);

  const stopPromise = notifier.stop();
  assert.strictEqual(notifier.stop(), stopPromise);
  await stopPromise;
  assert.equal(bus.released, true);
});

test("reports active bus and property-update failures", async () => {
  const bus = new FakeBus();
  const diagnostics: { stage: string; error: unknown }[] = [];
  const notifier = new KdeStatusNotifier({
    busFactory: () => bus,
    onError: (diagnostic) => diagnostics.push(diagnostic),
  });

  assert.equal(await notifier.start(), true);
  bus.emitError(new Error("connection lost"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(diagnostics[0]?.stage, "update");

  const secondBus = new FakeBus();
  const secondDiagnostics: { stage: string; error: unknown }[] = [];
  const secondNotifier = new KdeStatusNotifier({
    busFactory: () => secondBus,
    onError: (diagnostic) => secondDiagnostics.push(diagnostic),
  });
  assert.equal(await secondNotifier.start(), true);
  secondBus.failPropertyChanges = true;
  secondNotifier.setStatus("Passive");
  assert.equal(secondDiagnostics[0]?.stage, "update");
  await secondNotifier.stop();
});

test("serializes the menu over a real session bus", async (t) => {
  if (process.platform !== "linux" || !process.env.DBUS_SESSION_BUS_ADDRESS) {
    t.skip("a Linux D-Bus session bus is required");
    return;
  }

  const notifier = new KdeStatusNotifier({ pid: process.pid + 10_000 });
  if (!(await notifier.start())) {
    t.skip("no StatusNotifierWatcher is available");
    return;
  }

  const client = dbus.sessionBus();
  try {
    const menu = await client.getInterface<{
      GetLayout: (
        parentId: number,
        recursionDepth: number,
        propertyNames: string[],
      ) => Promise<[number, unknown]>;
    }>(notifier.serviceName, "/Menu", "com.canonical.dbusmenu");
    const [, rawLayout] = await menu.GetLayout(0, -1, []);
    const layout =
      toPlain<
        [
          number,
          Record<string, unknown>,
          [number, Record<string, unknown>, unknown[]][],
        ]
      >(rawLayout);
    assert.equal(layout[2][0]?.[1]?.label as string, "Stop keeping awake");
  } finally {
    await notifier.stop();
    await client.close();
  }
});

test("does not throw when the session bus is unavailable", async () => {
  let errors = 0;
  const notifier = new KdeStatusNotifier({
    busFactory: () => {
      throw new Error("no session bus");
    },
    onError: () => errors++,
  });

  assert.equal(await notifier.start(), false);
  assert.equal(errors, 1);
  await notifier.stop();
});
