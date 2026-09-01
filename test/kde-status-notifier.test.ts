import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  KdeStatusNotifier,
  formatStatusNotifierTooltip,
} from "../kde-status-notifier.js";

type Exported = { path: string; iface: unknown };

class FakeBus {
  readonly exported: Exported[] = [];
  readonly unexported: Exported[] = [];
  readonly registrations: string[] = [];
  released = false;
  disconnected = false;
  failKdeWatcher = false;

  async requestName(): Promise<number> {
    return 1;
  }

  async releaseName(): Promise<number> {
    this.released = true;
    return 1;
  }

  export(path: string, iface: unknown): void {
    this.exported.push({ path, iface });
  }

  unexport(path: string, iface?: unknown): void {
    this.unexported.push({ path, iface });
  }

  async getProxyObject(name: string): Promise<{
    getInterface: (interfaceName: string) => {
      RegisterStatusNotifierItem: (service: string) => Promise<void>;
    };
  }> {
    if (this.failKdeWatcher && name === "org.kde.StatusNotifierWatcher") {
      throw new Error("KDE watcher missing");
    }
    return {
      getInterface: () => ({
        RegisterStatusNotifierItem: async (service: string) => {
          this.registrations.push(service);
        },
      }),
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
  assert.equal(notifier.serviceName, "org.freedesktop.StatusNotifierItem-1234-1");
  assert.deepEqual(bus.registrations, [notifier.serviceName]);
  assert.equal(bus.exported.length, 2);

  const item = bus.exported[0]!.iface as {
    Status: string;
    Category: string;
    Id: string;
    IconName: string;
    ToolTip: [string, unknown[], string, string];
    Activate: (x: number, y: number) => void;
    NewStatus: (status: string) => void;
    NewToolTip: () => void;
  };
  assert.equal(item.Status, "Active");
  assert.equal(item.Category, "SystemServices");
  assert.equal(item.Id, "pi-caffeinated");
  assert.equal(item.IconName, "");
  assert.equal(item.ToolTip[3], formatStatusNotifierTooltip());
  assert.deepEqual(
    KdeStatusNotifier.COFFEE_ICON_PIXMAP.map(([width, height]) => [width, height]),
    [[16, 16], [22, 22], [24, 24], [32, 32]],
  );
  for (const [width, height, pixels] of KdeStatusNotifier.COFFEE_ICON_PIXMAP) {
    assert.equal(pixels.length, width * height * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset] === 0) continue;
      assert.deepEqual([...pixels.subarray(offset, offset + 4)], [255, 255, 255, 255]);
    }
  }
  const pixels24 = KdeStatusNotifier.COFFEE_ICON_PIXMAP[2]![2];
  const piTopOffset = (12 * 24 + 9) * 4;
  assert.deepEqual([...pixels24.subarray(piTopOffset, piTopOffset + 4)], [255, 255, 255, 255]);
  item.Activate(0, 0);
  assert.equal(activated, 1);
  let statusSignals = 0;
  let tooltipSignals = 0;
  item.NewStatus = () => {
    statusSignals++;
  };
  item.NewToolTip = () => {
    tooltipSignals++;
  };

  notifier.setStatus("Passive");
  notifier.setStatus("Passive");
  assert.equal(notifier.status, "Passive");
  assert.equal(statusSignals, 1);

  notifier.setTooltip("first tooltip");
  notifier.setTooltip("first tooltip");
  assert.equal(tooltipSignals, 1);

  notifier.update({ elapsed: "12s", inhibited: "idle+sleep" });
  assert.equal(item.ToolTip[3], "[awake] idle+sleep · 12s");

  await notifier.stop();
  assert.equal(bus.unexported.length, 1);
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
