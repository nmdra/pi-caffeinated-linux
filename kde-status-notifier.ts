import {
  NameFlag,
  RequestNameReply,
  sessionBus,
  interface as dbusInterface,
} from "dbus-next";
/** A single StatusNotifierItem pixmap: width, height, and ARGB bytes. */
type StatusNotifierPixmap = [number, number, Buffer];
type StatusNotifierToolTip = [
  string,
  StatusNotifierPixmap[],
  string,
  string,
];

const TRAY_ICON_SIZES = [16, 22, 24, 32] as const;

/** Draw a crisp white point into an ARGB StatusNotifierItem pixmap. */
function setWhitePixel(pixels: Buffer, size: number, x: number, y: number): void {
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
  const line = (fromX: number, fromY: number, toX: number, toY: number): void => {
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
  path([[10, 2], [9, 4], [10, 6]]);
  path([[15, 2], [16, 4], [15, 6]]);
  path([[5, 8], [5, 15], [6, 18], [8, 20], [16, 20], [18, 18], [19, 15], [19, 8], [5, 8]]);
  path([[19, 10], [21, 10], [22, 11], [22, 14], [21, 15], [19, 15]]);

  // π identifies the tray item as Pi without filling the cup or blurring it.
  line(9, 12, 15, 12);
  line(10, 12, 10, 16);
  line(14, 12, 14, 16);

  return pixels;
}

// Leave IconName empty so hosts select the crisp branded pixmap, not a theme icon.
const COFFEE_ICON_NAME = "";
const COFFEE_ICON_PIXMAP: StatusNotifierPixmap[] = TRAY_ICON_SIZES.map((size) => [
  size,
  size,
  createCoffeePixels(size),
]);

/** The subset of MessageBus used by this module, suitable for a fake bus. */
interface KdeStatusNotifierBus {
  requestName(name: string, flags: number): Promise<number>;
  releaseName(name: string): Promise<number>;
  export(path: string, iface: dbusInterface.Interface): void;
  unexport(path: string, iface?: dbusInterface.Interface): void;
  getProxyObject(
    name: string,
    path: string,
  ): Promise<KdeStatusNotifierProxy>;
  disconnect?(): void;
  on?(event: "error", listener: (error: unknown) => void): void;
  removeListener?(event: "error", listener: (error: unknown) => void): void;
}

interface KdeStatusNotifierProxy {
  getInterface(name: string): KdeStatusNotifierWatcher;
}

interface KdeStatusNotifierWatcher {
  RegisterStatusNotifierItem(service: string): Promise<unknown>;
}

export interface KdeStatusNotifierOptions {
  /** Inject a fake bus in tests. The default is dbus-next's sessionBus(). */
  busFactory?: () => KdeStatusNotifierBus;
  /** The pid used in the stable item service name. Defaults to process.pid. */
  pid?: number;
  /** Called when a tray click requests that caffeinate stop. */
  onActivate?: () => void | Promise<void>;
  /** Optional one-time diagnostic hook for unavailable D-Bus. */
  onError?: (error: unknown) => void;
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
const NO_DBUSMENU_PATH = "/NO_DBUSMENU";
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
class StatusNotifierItemInterface extends dbusInterface.Interface {
  public constructor(
    name: string,
    private readonly state: ItemState,
    private readonly reportActivationError: (error: unknown) => void,
  ) {
    super(name);
  }

  public get Id(): string {
    return this.state.id;
  }

  public get Title(): string {
    return this.state.title;
  }

  public get Category(): string {
    return "SystemServices";
  }

  public get Status(): string {
    return this.state.status;
  }

  public get WindowId(): number {
    return 0;
  }

  public get IconName(): string {
    return COFFEE_ICON_NAME;
  }

  public get IconPixmap(): StatusNotifierPixmap[] {
    return COFFEE_ICON_PIXMAP;
  }

  public get OverlayIconName(): string {
    return "";
  }

  public get OverlayIconPixmap(): StatusNotifierPixmap[] {
    return [];
  }

  public get AttentionIconName(): string {
    return "";
  }

  public get AttentionIconPixmap(): StatusNotifierPixmap[] {
    return [];
  }

  public get AttentionMovieName(): string {
    return "";
  }

  public get ToolTip(): StatusNotifierToolTip {
    return [COFFEE_ICON_NAME, COFFEE_ICON_PIXMAP, this.state.title, this.state.tooltip];
  }

  public get Menu(): string {
    return NO_DBUSMENU_PATH;
  }

  public Activate(_x: number, _y: number): void {
    try {
      const result = this.state.onActivate?.();
      if (result && typeof (result as Promise<void>).then === "function") {
        void Promise.resolve(result).catch(this.reportActivationError);
      }
    } catch (error) {
      this.reportActivationError(error);
    }
  }

  public ContextMenu(_x: number, _y: number): void {
    // A DBusMenu is deliberately not part of this extension.
  }

  public SecondaryActivate(_x: number, _y: number): void {
    // No secondary action is needed; the primary click stops caffeinate.
  }

  public Scroll(_delta: number, _orientation: string): void {
    // StatusNotifierItem requires this method even without scroll behavior.
  }

  public NewTitle(): void {}
  public NewIcon(): void {}
  public NewAttentionIcon(): void {}
  public NewOverlayIcon(): void {}
  public NewToolTip(): void {}
  public NewStatus(_status: string): void {}
}

StatusNotifierItemInterface.configureMembers({
  properties: {
    Id: { signature: "s", access: "read" },
    Title: { signature: "s", access: "read" },
    Category: { signature: "s", access: "read" },
    Status: { signature: "s", access: "read" },
    WindowId: { signature: "i", access: "read" },
    IconName: { signature: "s", access: "read" },
    IconPixmap: { signature: "a(iiay)", access: "read" },
    OverlayIconName: { signature: "s", access: "read" },
    OverlayIconPixmap: { signature: "a(iiay)", access: "read" },
    AttentionIconName: { signature: "s", access: "read" },
    AttentionIconPixmap: { signature: "a(iiay)", access: "read" },
    AttentionMovieName: { signature: "s", access: "read" },
    ToolTip: { signature: "(sa(iiay)ss)", access: "read" },
    Menu: { signature: "o", access: "read" },
  },
  methods: {
    Activate: { inSignature: "ii" },
    ContextMenu: { inSignature: "ii" },
    SecondaryActivate: { inSignature: "ii" },
    Scroll: { inSignature: "is" },
  },
  signals: {
    NewTitle: { signature: "" },
    NewIcon: { signature: "" },
    NewAttentionIcon: { signature: "" },
    NewOverlayIcon: { signature: "" },
    NewToolTip: { signature: "" },
    NewStatus: { signature: "s" },
  },
});

function defaultBusFactory(): KdeStatusNotifierBus {
  // SAFETY: KdeStatusNotifierBus is the intentionally small structural subset
  // of dbus-next's MessageBus used by this module.
  return sessionBus() as unknown as KdeStatusNotifierBus;
}

function isNameOwner(reply: number): boolean {
  return (
    reply === RequestNameReply.PRIMARY_OWNER ||
    reply === RequestNameReply.ALREADY_OWNER
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
  private readonly onError?: (error: unknown) => void;
  private state: ItemState;
  private bus?: KdeStatusNotifierBus;
  private kdeInterface?: StatusNotifierItemInterface;
  private freedesktopInterface?: StatusNotifierItemInterface;
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
    this.reportError(error);
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

    try {
      const bus = this.busFactory();
      this.bus = bus;
      bus.on?.("error", this.busErrorListener);

      const reply = await bus.requestName(
        this.serviceName,
        NameFlag.DO_NOT_QUEUE,
      );
      if (generation !== this.lifecycle) {
        await this.stop();
        return false;
      }
      if (!isNameOwner(reply)) {
        throw new Error(`could not claim ${this.serviceName} (reply ${reply})`);
      }
      this.nameClaimed = true;

      this.kdeInterface = new StatusNotifierItemInterface(
        "org.kde.StatusNotifierItem",
        this.state,
        this.reportError,
      );
      this.freedesktopInterface = new StatusNotifierItemInterface(
        "org.freedesktop.StatusNotifierItem",
        this.state,
        this.reportError,
      );
      bus.export(ITEM_PATH, this.kdeInterface);
      this.kdeExported = true;
      bus.export(ITEM_PATH, this.freedesktopInterface);
      this.freedesktopExported = true;

      if (!(await this.registerWithWatcher(KDE_WATCHER))) {
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
      this.reportError(error);
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
    const next = typeof update === "string" ? { tooltip: update, status } : update;
    let nextTooltip = next.tooltip;
    if (!nextTooltip && (next.elapsed !== undefined || next.inhibited !== undefined)) {
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

    if (this.kdeExported || this.freedesktopExported) {
      try {
        // dbus-next removes the whole service object when unexport(path) is
        // used, which correctly removes both interfaces at this path.
        bus.unexport(ITEM_PATH);
      } catch (error) {
        this.reportError(error);
      }
    }
    this.kdeExported = false;
    this.freedesktopExported = false;
    this.kdeInterface = undefined;
    this.freedesktopInterface = undefined;

    if (this.nameClaimed) {
      try {
        await bus.releaseName(this.serviceName);
      } catch (error) {
        this.reportError(error);
      }
      this.nameClaimed = false;
    }

    try {
      bus.removeListener?.("error", this.busErrorListener);
    } catch (error) {
      this.reportError(error);
    }
    try {
      bus.disconnect?.();
    } catch (error) {
      this.reportError(error);
    }
  }

  private async registerWithWatcher(watcher: {
    name: string;
    interface: string;
  }): Promise<boolean> {
    if (!this.bus) return false;
    try {
      const proxy = await this.bus.getProxyObject(watcher.name, "/StatusNotifierWatcher");
      const iface = proxy.getInterface(watcher.interface);
      await iface.RegisterStatusNotifierItem(this.serviceName);
      return true;
    } catch (error) {
      this.reportError(error, false);
      return false;
    }
  }

  private emitStatusChanged(status: string): void {
    const interfaces = [this.kdeInterface, this.freedesktopInterface];
    for (const iface of interfaces) {
      if (!iface) continue;
      try {
        dbusInterface.Interface.emitPropertiesChanged(iface, { Status: status }, []);
        iface.NewStatus(status);
      } catch (error) {
        this.reportError(error, false);
      }
    }
  }

  private emitTooltipChanged(): void {
    const interfaces = [this.kdeInterface, this.freedesktopInterface];
    for (const iface of interfaces) {
      if (!iface) continue;
      try {
        dbusInterface.Interface.emitPropertiesChanged(iface, { ToolTip: iface.ToolTip }, []);
        iface.NewToolTip();
      } catch (error) {
        this.reportError(error, false);
      }
    }
  }

  private readonly reportError = (error: unknown, report = true): void => {
    if (!report || this.errorReported) return;
    this.errorReported = true;
    try {
      this.onError?.(error);
    } catch {
      // Diagnostics must never turn optional tray integration into a failure.
    }
  };
}
