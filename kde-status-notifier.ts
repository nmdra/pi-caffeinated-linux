import dbus, {
  defineInterface,
  type DefinedInterface,
  Variant,
} from "dbus-native";

const NAME_FLAG_DO_NOT_QUEUE = 4;
const REQUEST_NAME_PRIMARY_OWNER = 1;
const REQUEST_NAME_ALREADY_OWNER = 4;
/** A single StatusNotifierItem pixmap: width, height, and ARGB bytes. */
type StatusNotifierPixmap = [number, number, Buffer];

const TRAY_ICON_SIZES = [16, 22, 24, 32] as const;

/** Draw a crisp white point into an ARGB StatusNotifierItem pixmap. */
function setWhitePixel(
  pixels: Buffer,
  size: number,
  x: number,
  y: number,
): void {
  if (x < 0 || x >= size || y < 0 || y >= size) return;
  const offset = (y * size + x) * 4;
  pixels[offset] = 255;
  pixels[offset + 1] = 255;
  pixels[offset + 2] = 255;
  pixels[offset + 3] = 255;
}

function drawWhiteLine(
  pixels: Buffer,
  size: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): void {
  let x = startX;
  let y = startY;
  const stepX = Math.sign(endX - startX);
  const stepY = Math.sign(endY - startY);
  const deltaX = Math.abs(endX - startX);
  const deltaY = -Math.abs(endY - startY);
  let error = deltaX + deltaY;

  while (true) {
    setWhitePixel(pixels, size, x, y);
    if (x === endX && y === endY) return;
    const doubledError = 2 * error;
    if (doubledError >= deltaY) {
      error += deltaY;
      x += stepX;
    }
    if (doubledError <= deltaX) {
      error += deltaX;
      y += stepY;
    }
  }
}

/**
 * Render a white outlined mug from the supplied coffee-mug SVG silhouette.
 * The explicit 16/22/24/32 pixel variants let Plasma choose a native tray
 * size instead of resampling the old 8×8 amber fallback.
 */
function createCoffeePixels(size: number): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const point = (value: number): number => Math.round((value * size) / 24);
  const line = (
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): void => {
    drawWhiteLine(
      pixels,
      size,
      point(fromX),
      point(fromY),
      point(toX),
      point(toY),
    );
  };
  const path = (points: readonly (readonly [number, number])[]): void => {
    for (let index = 1; index < points.length; index += 1) {
      const [fromX, fromY] = points[index - 1]!;
      const [toX, toY] = points[index]!;
      line(fromX, fromY, toX, toY);
    }
  };

  // Steam, cup bowl, and handle preserve the proportions of the reference mug.
  path([
    [10, 2],
    [9, 4],
    [10, 6],
  ]);
  path([
    [15, 2],
    [16, 4],
    [15, 6],
  ]);
  path([
    [5, 8],
    [5, 15],
    [6, 18],
    [8, 20],
    [16, 20],
    [18, 18],
    [19, 15],
    [19, 8],
    [5, 8],
  ]);
  path([
    [19, 10],
    [21, 10],
    [22, 11],
    [22, 14],
    [21, 15],
    [19, 15],
  ]);

  // π identifies the tray item as Pi without filling the cup or blurring it.
  line(9, 12, 15, 12);
  line(10, 12, 10, 16);
  line(14, 12, 14, 16);

  return pixels;
}

// Leave IconName empty so hosts select the crisp branded pixmap, not a theme icon.
const COFFEE_ICON_NAME = "";
const COFFEE_ICON_PIXMAP: StatusNotifierPixmap[] = TRAY_ICON_SIZES.map(
  (size) => [size, size, createCoffeePixels(size)],
);

/** The subset of MessageBus used by this module, suitable for a fake bus. */
export type KdeStatusNotifierDiagnosticStage =
  | "connect"
  | "claim-name"
  | "export"
  | "register-kde-watcher"
  | "register-freedesktop-watcher"
  | "activate"
  | "update"
  | "release";

export type KdeStatusNotifierDiagnostic = {
  stage: KdeStatusNotifierDiagnosticStage;
  error: unknown;
};

interface KdeStatusNotifierBus {
  requestName(name: string, flags: number): Promise<number>;
  releaseName(name: string): Promise<number>;
  export(path: string, iface: DefinedInterface): void | Promise<unknown>;
  unexport(path: string, iface?: unknown): void;
  unexportInterface?(path: string, interfaceName?: string): boolean;
  emitPropertiesChanged?(
    path: string,
    interfaceName: string,
    changed: Record<string, unknown>,
    invalidated?: string[],
  ): void;
  getInterface(
    service: string,
    path: string,
    interfaceName: string,
  ): Promise<KdeStatusNotifierWatcher>;
  close?(): Promise<void> | void;
  disconnect?(): void;
  on?(event: "error", listener: (error: unknown) => void): void;
  removeListener?(event: "error", listener: (error: unknown) => void): void;
}

interface KdeStatusNotifierWatcher {
  RegisterStatusNotifierItem(service: string): Promise<unknown>;
}

export interface KdeStatusNotifierOptions {
  /** Inject a fake bus in tests. The default is dbus-native's sessionBus(). */
  busFactory?: () => KdeStatusNotifierBus;
  /** The pid used in the stable item service name. Defaults to process.pid. */
  pid?: number;
  /** Called when a tray click requests that caffeinate stop. */
  onActivate?: () => void | Promise<void>;
  /** Optional one-time diagnostic hook for unavailable D-Bus. */
  onError?: (diagnostic: KdeStatusNotifierDiagnostic) => void;
  id?: string;
  title?: string;
}

interface KdeStatusNotifierUpdate {
  /** Full text shown by the tray item's tooltip. */
  tooltip?: string;
  /** StatusNotifierItem status, normally "Active" or "Passive". */
  status?: string;
  /** Convenience fields for the standard caffeinate tooltip. */
  elapsed?: string;
  inhibited?: string;
}

const ITEM_PATH = "/StatusNotifierItem";
const DBUSMENU_PATH = "/Menu";
const KDE_WATCHER = {
  name: "org.kde.StatusNotifierWatcher",
  interface: "org.kde.StatusNotifierWatcher",
};
const FREEDESKTOP_WATCHER = {
  name: "org.freedesktop.StatusNotifierWatcher",
  interface: "org.freedesktop.StatusNotifierWatcher",
};

/** Format the tooltip shared by the Pi and tray indicators. */
export function formatStatusNotifierTooltip(
  elapsed = "0:00",
  inhibited = "idle+sleep",
): string {
  return `[awake] ${inhibited} · ${elapsed}`;
}

type ItemState = {
  readonly id: string;
  readonly title: string;
  status: string;
  tooltip: string;
  onActivate?: () => void | Promise<void>;
};

/**
 * The exported D-Bus object. configureMembers is used instead of decorators
 * because the package is consumed as TypeScript source by Pi.
 */
function activate(
  onActivate: ItemState["onActivate"],
  report: (error: unknown, stage: KdeStatusNotifierDiagnosticStage) => void,
): void {
  try {
    const result = onActivate?.();
    if (result && typeof (result as Promise<void>).then === "function") {
      void Promise.resolve(result).catch((error) => report(error, "activate"));
    }
  } catch (error) {
    report(error, "activate");
  }
}

function createStatusNotifierInterface(
  name: string,
  state: ItemState,
  report: (error: unknown, stage: KdeStatusNotifierDiagnosticStage) => void,
): DefinedInterface {
  return defineInterface({
    name,
    properties: {
      Id: { type: "s", access: "read", get: () => state.id },
      Title: { type: "s", access: "read", get: () => state.title },
      Category: { type: "s", access: "read", get: () => "SystemServices" },
      Status: { type: "s", access: "read", get: () => state.status },
      WindowId: { type: "i", access: "read", value: 0 },
      IconName: { type: "s", access: "read", value: COFFEE_ICON_NAME },
      IconPixmap: {
        type: "a(iiay)",
        access: "read",
        value: COFFEE_ICON_PIXMAP,
      },
      OverlayIconName: { type: "s", access: "read", value: "" },
      OverlayIconPixmap: { type: "a(iiay)", access: "read", value: [] },
      AttentionIconName: { type: "s", access: "read", value: "" },
      AttentionIconPixmap: { type: "a(iiay)", access: "read", value: [] },
      AttentionMovieName: { type: "s", access: "read", value: "" },
      ToolTip: {
        type: "(sa(iiay)ss)",
        access: "read",
        get: () => [
          COFFEE_ICON_NAME,
          COFFEE_ICON_PIXMAP,
          state.title,
          state.tooltip,
        ],
      },
      Menu: { type: "o", access: "read", value: DBUSMENU_PATH },
    },
    methods: {
      Activate: {
        in: { x: "i", y: "i" },
        handler: () => {
          activate(state.onActivate, report);
          return null;
        },
      },
      ContextMenu: { in: { x: "i", y: "i" }, handler: () => null },
      SecondaryActivate: { in: { x: "i", y: "i" }, handler: () => null },
      Scroll: { in: { delta: "i", orientation: "s" }, handler: () => null },
    },
    signals: {
      NewTitle: {},
      NewIcon: {},
      NewAttentionIcon: {},
      NewOverlayIcon: {},
      NewToolTip: {},
      NewStatus: { args: { status: "s" } },
    },
  });
}

function createMenuInterface(
  onActivate: () => void | Promise<void>,
  report: (error: unknown, stage: KdeStatusNotifierDiagnosticStage) => void,
): DefinedInterface {
  return defineInterface({
    name: "com.canonical.dbusmenu",
    properties: {
      Version: { type: "u", access: "read", value: Layout_REVISION },
    },
    methods: {
      GetLayout: {
        in: { parentId: "i", recursionDepth: "i", propertyNames: "as" },
        out: { revision: "u", layout: "(ia{sv}av)" },
        handler: () => ({
          revision: Layout_REVISION,
          layout: [
            0,
            {},
            [
              new Variant("(ia{sv}av)", [
                1,
                {
                  label: new Variant("s", "Stop keeping awake"),
                  type: new Variant("s", "standard"),
                },
                [],
              ]),
            ],
          ],
        }),
      },
      GetGroupProperties: {
        in: { ids: "ai", propertyNames: "as" },
        out: { properties: "a(ia{sv})" },
        handler: ({
          ids,
          propertyNames,
        }: {
          ids: number[];
          propertyNames: string[];
        }) =>
          ids.includes(1)
            ? [
                [
                  1,
                  Object.fromEntries(
                    propertyNames
                      .filter((name) => name === "label" || name === "type")
                      .map((name) => [
                        name,
                        new Variant(
                          "s",
                          name === "label" ? "Stop keeping awake" : "standard",
                        ),
                      ]),
                  ),
                ],
              ]
            : [],
      },
      GetProperty: {
        in: { id: "i", name: "s" },
        out: { value: "v" },
        handler: ({ id, name }: { id: number; name: string }) =>
          new Variant(
            "s",
            id === 1 && name === "label"
              ? "Stop keeping awake"
              : id === 1 && name === "type"
                ? "standard"
                : "",
          ),
      },
      AboutToShow: {
        in: { id: "i" },
        out: { needUpdate: "b" },
        handler: () => false,
      },
      Event: {
        in: { id: "i", eventId: "s", data: "v", timestamp: "u" },
        handler: ({ id, eventId }: { id: number; eventId: string }) => {
          if (id === 1 && eventId === "clicked") activate(onActivate, report);
          return null;
        },
      },
    },
    signals: {
      ItemsPropertiesUpdated: {
        args: { updatedProps: "a(ia{sv})", removedProps: "a(ias)" },
      },
      LayoutUpdated: { args: { revision: "u", parent: "i" } },
    },
  });
}

const Layout_REVISION = 1;

function defaultBusFactory(): KdeStatusNotifierBus {
  // SAFETY: The local interface is the intentionally small subset of the
  // dbus-native MessageBus used by this module and its tests.
  return dbus.sessionBus() as unknown as KdeStatusNotifierBus;
}

function isNameOwner(reply: number): boolean {
  return (
    reply === REQUEST_NAME_PRIMARY_OWNER || reply === REQUEST_NAME_ALREADY_OWNER
  );
}

/**
 * A small, deliberately defensive StatusNotifierItem service.
 *
 * D-Bus is an optional desktop integration: start(), update(), and stop()
 * never let a bus or watcher failure escape to the inhibitor caller.
 */
export class KdeStatusNotifier {
  public static readonly COFFEE_ICON_NAME = COFFEE_ICON_NAME;
  public static readonly COFFEE_ICON_PIXMAP = COFFEE_ICON_PIXMAP;
  public static readonly coffeeIconName = COFFEE_ICON_NAME;
  public static readonly coffeeIconPixmap = COFFEE_ICON_PIXMAP;

  public readonly serviceName: string;
  public readonly objectPath = ITEM_PATH;

  private readonly busFactory: () => KdeStatusNotifierBus;
  private readonly id: string;
  private readonly title: string;
  private readonly onActivate?: () => void | Promise<void>;
  private readonly onError?: (diagnostic: KdeStatusNotifierDiagnostic) => void;
  private state: ItemState;
  private bus?: KdeStatusNotifierBus;
  private kdeInterface?: DefinedInterface;
  private freedesktopInterface?: DefinedInterface;
  private menuInterface?: DefinedInterface;
  private menuExported = false;
  private nameClaimed = false;
  private kdeExported = false;
  private freedesktopExported = false;
  private active = false;
  private errorReported = false;
  private lifecycle = 0;
  private startPromise: Promise<boolean> | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly busErrorListener = (error: unknown): void => {
    // MessageBus emits error events for transport failures. Do not allow an
    // unhandled EventEmitter error to terminate Pi; release the optional tray
    // item while leaving the systemd inhibitor untouched.
    this.reportError(error, "update");
    void this.stop();
  };

  public constructor(options: KdeStatusNotifierOptions = {}) {
    const pid = options.pid ?? process.pid;
    this.serviceName = `org.freedesktop.StatusNotifierItem-${pid}-1`;
    this.id = options.id ?? "pi-caffeinated";
    this.title = options.title ?? "Pi Caffeinated";
    this.onActivate = options.onActivate;
    this.onError = options.onError;
    this.busFactory = options.busFactory ?? defaultBusFactory;
    this.state = {
      id: this.id,
      title: this.title,
      status: "Active",
      tooltip: formatStatusNotifierTooltip(),
      onActivate: this.onActivate,
    };
  }

  public get status(): string {
    return this.state.status;
  }

  public get tooltip(): string {
    return this.state.tooltip;
  }

  /** Connect, export the item, and register it with a watcher. */
  public start(): Promise<boolean> {
    if (this.active) return Promise.resolve(true);
    if (this.startPromise) return this.startPromise;

    const promise = this.startInternal();
    this.startPromise = promise;
    void promise.finally(() => {
      if (this.startPromise === promise) this.startPromise = null;
    });
    return promise;
  }

  private async startInternal(): Promise<boolean> {
    const generation = ++this.lifecycle;
    this.errorReported = false;
    let stage: KdeStatusNotifierDiagnosticStage = "connect";

    try {
      const bus = this.busFactory();
      this.bus = bus;
      bus.on?.("error", this.busErrorListener);

      stage = "claim-name";
      const reply = await bus.requestName(
        this.serviceName,
        NAME_FLAG_DO_NOT_QUEUE,
      );
      if (generation !== this.lifecycle) {
        await this.stop();
        return false;
      }
      if (!isNameOwner(reply)) {
        throw new Error(`could not claim ${this.serviceName} (reply ${reply})`);
      }
      this.nameClaimed = true;

      stage = "export";
      this.kdeInterface = createStatusNotifierInterface(
        "org.kde.StatusNotifierItem",
        this.state,
        this.reportError,
      );
      this.freedesktopInterface = createStatusNotifierInterface(
        "org.freedesktop.StatusNotifierItem",
        this.state,
        this.reportError,
      );
      this.menuInterface = createMenuInterface(
        this.onActivate ?? (() => undefined),
        this.reportError,
      );
      await bus.export(ITEM_PATH, this.kdeInterface);
      this.kdeExported = true;
      await bus.export(ITEM_PATH, this.freedesktopInterface);
      this.freedesktopExported = true;
      await bus.export(DBUSMENU_PATH, this.menuInterface);
      this.menuExported = true;

      stage = "register-kde-watcher";
      if (!(await this.registerWithWatcher(KDE_WATCHER))) {
        stage = "register-freedesktop-watcher";
        if (!(await this.registerWithWatcher(FREEDESKTOP_WATCHER))) {
          throw new Error("no StatusNotifierWatcher is available");
        }
      }
      if (generation !== this.lifecycle) {
        await this.stop();
        return false;
      }

      this.active = true;
      return true;
    } catch (error) {
      this.reportError(error, stage);
      await this.stop();
      return false;
    }
  }

  /**
   * Update the tooltip and/or status. Passing a string is shorthand for a
   * tooltip update; the optional second argument changes Status as well.
   */
  public update(
    update: KdeStatusNotifierUpdate | string,
    status?: string,
  ): void {
    const next =
      typeof update === "string" ? { tooltip: update, status } : update;
    let nextTooltip = next.tooltip;
    if (
      !nextTooltip &&
      (next.elapsed !== undefined || next.inhibited !== undefined)
    ) {
      nextTooltip = formatStatusNotifierTooltip(next.elapsed, next.inhibited);
    }

    if (next.status !== undefined && next.status !== this.state.status) {
      this.state.status = next.status;
      this.emitStatusChanged(next.status);
    }
    if (nextTooltip !== undefined && nextTooltip !== this.state.tooltip) {
      this.state.tooltip = nextTooltip;
      this.emitTooltipChanged();
    }
  }

  public setStatus(status: string): void {
    this.update({ status });
  }

  public setTooltip(tooltip: string): void {
    this.update({ tooltip });
  }

  /** Unexport and release the item. Every cleanup operation is best effort. */
  public stop(): Promise<void> {
    this.lifecycle++;
    if (this.stopPromise) return this.stopPromise;

    const promise = this.stopInternal();
    this.stopPromise = promise;
    void promise.finally(() => {
      if (this.stopPromise === promise) this.stopPromise = null;
    });
    return promise;
  }

  private async stopInternal(): Promise<void> {
    const bus = this.bus;
    this.active = false;
    this.bus = undefined;

    if (!bus) return;

    if (this.menuExported || this.kdeExported || this.freedesktopExported) {
      try {
        if (bus.unexportInterface) {
          if (this.menuExported)
            bus.unexportInterface(DBUSMENU_PATH, "com.canonical.dbusmenu");
          if (this.kdeExported)
            bus.unexportInterface(ITEM_PATH, "org.kde.StatusNotifierItem");
          if (this.freedesktopExported)
            bus.unexportInterface(
              ITEM_PATH,
              "org.freedesktop.StatusNotifierItem",
            );
        } else {
          if (this.menuExported) bus.unexport(DBUSMENU_PATH);
          if (this.kdeExported || this.freedesktopExported)
            bus.unexport(ITEM_PATH);
        }
      } catch (error) {
        this.reportError(error, "release");
      }
    }
    this.menuExported = false;
    this.kdeExported = false;
    this.freedesktopExported = false;
    this.kdeInterface = undefined;
    this.freedesktopInterface = undefined;
    this.menuInterface = undefined;

    if (this.nameClaimed) {
      try {
        await bus.releaseName(this.serviceName);
      } catch (error) {
        this.reportError(error, "release");
      }
      this.nameClaimed = false;
    }

    try {
      bus.removeListener?.("error", this.busErrorListener);
    } catch (error) {
      this.reportError(error, "release");
    }
    try {
      if (bus.close) await bus.close();
      else bus.disconnect?.();
    } catch (error) {
      this.reportError(error, "release");
    }
  }

  private async registerWithWatcher(watcher: {
    name: string;
    interface: string;
  }): Promise<boolean> {
    if (!this.bus) return false;
    try {
      const iface = await this.bus.getInterface(
        watcher.name,
        "/StatusNotifierWatcher",
        watcher.interface,
      );
      await iface.RegisterStatusNotifierItem(this.serviceName);
      return true;
    } catch (error) {
      const stage =
        watcher === KDE_WATCHER
          ? "register-kde-watcher"
          : "register-freedesktop-watcher";
      this.reportError(error, stage, false);
      return false;
    }
  }

  private emitStatusChanged(status: string): void {
    const interfaces = [this.kdeInterface, this.freedesktopInterface];
    for (const iface of interfaces) {
      if (!iface) continue;
      try {
        this.bus?.emitPropertiesChanged?.(
          ITEM_PATH,
          iface.name,
          { Status: status },
          [],
        );
        iface.emit.NewStatus(status);
      } catch (error) {
        this.reportError(error, "update");
      }
    }
  }

  private emitTooltipChanged(): void {
    const interfaces = [this.kdeInterface, this.freedesktopInterface];
    for (const iface of interfaces) {
      if (!iface) continue;
      try {
        this.bus?.emitPropertiesChanged?.(
          ITEM_PATH,
          iface.name,
          {
            ToolTip: [
              COFFEE_ICON_NAME,
              COFFEE_ICON_PIXMAP,
              this.state.title,
              this.state.tooltip,
            ],
          },
          [],
        );
        iface.emit.NewToolTip();
      } catch (error) {
        this.reportError(error, "update");
      }
    }
  }

  private readonly reportError = (
    error: unknown,
    stage: KdeStatusNotifierDiagnosticStage = "connect",
    report = true,
  ): void => {
    if (!report || this.errorReported) return;
    this.errorReported = true;
    try {
      this.onError?.({ stage, error });
    } catch {
      // Diagnostics must never turn optional tray integration into a failure.
    }
  };
}
