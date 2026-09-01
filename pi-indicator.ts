import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const INDICATOR_TICK_MS = 700;

/** Small ASCII-only frames for the non-capturing Pi overlay. */
export const COFFEE_FRAMES = [
  ["  ~   ", " ( )  ", "(___) >"],
  [" ~ ~  ", " ( )  ", "(___) >"],
  ["   ~  ", " ( )  ", "(___) >"],
  ["      ", " ( )  ", "(___) >"],
] as const;

type TuiHandle = { requestRender: () => void };

type StyleFn = (text: string) => string;

function padVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export class CaffeinateIndicator {
  private readonly tui: TuiHandle;
  private readonly theme: Theme;
  private interval: ReturnType<typeof setInterval> | null;
  private frame = 0;
  private cachedLines: string[] = [];
  private cachedWidth = -1;
  private cachedFrame = -1;

  constructor(tui: TuiHandle, theme: Theme) {
    this.tui = tui;
    this.theme = theme;
    this.interval = setInterval(() => this.advance(), INDICATOR_TICK_MS);
  }

  /** Advance the animation and ask Pi to repaint the overlay. */
  advance(): void {
    this.frame++;
    this.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth === this.cachedWidth && this.frame === this.cachedFrame) {
      return this.cachedLines;
    }

    if (safeWidth === 0) {
      this.cachedLines = [""];
      this.cachedWidth = safeWidth;
      this.cachedFrame = this.frame;
      return this.cachedLines;
    }

    const accent: StyleFn = (text) => this.theme.fg("accent", text);
    const rawFrame = COFFEE_FRAMES[this.frame % COFFEE_FRAMES.length];
    const frameWidth = Math.max(
      ...rawFrame.map((line) => visibleWidth(line)),
    );

    this.cachedLines = rawFrame.map((line) => {
      const clipped = truncateToWidth(line, safeWidth, "");
      return padVisible(accent(clipped), Math.min(safeWidth, frameWidth));
    });
    this.cachedWidth = safeWidth;
    this.cachedFrame = this.frame;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedFrame = -1;
  }

  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
