/**
 * /caffeinate — toggle a platform-native keep-awake process.
 * While running, Pi shows a centered coffee break modal.
 * Press Escape to stop caffeinating.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const TICK_MS = 700;
const WIDE_INNER_WIDTH = 74;
const WIDE_ART_MIN_WIDTH = 69;
const CODE_WIDTH = 11;
const CODE_ROWS = 3;
const CODE_REVEAL_STEPS = 7;

type TuiHandle = { requestRender: () => void };
type StyleFn = (text: string) => string;
type AwakeCommand = {
  cmd: string;
  args: string[];
  label: string;
  awakeMessage: string;
};

const TERMINAL_STREAM = [
  "$ caffein",
  "> pi dev",
  "keep awake",
  "brew 200",
  "tsc -w",
  "render()",
  "sleep off",
  "watching",
  "tests ok",
  "hot reload",
];

const STEAM_FRAMES = [
  ["       )  (  ", "      (   ) )", "       ) ( ( "],
  ["      (  )   ", "       )  (  ", "      ( (  ) "],
  ["       (  )  ", "      (   )  ", "       ) ) ( "],
  ["      )  (   ", "     (   ) ) ", "      ) ( (  "],
];

function getAwakeCommand(): AwakeCommand | null {
  switch (process.platform) {
    case "darwin":
      return {
        cmd: "caffeinate",
        args: ["-dimsu"],
        label: "macOS caffeinate",
        awakeMessage: "Your Mac won't sleep.",
      };
    case "linux":
      return {
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
        awakeMessage: "Your machine won't idle-sleep.",
      };
    case "win32":
      return {
        cmd: "powershell.exe",
        args: [
          "-NoProfile",
          "-NoLogo",
          "-WindowStyle",
          "Hidden",
          "-Command",
          [
            "Add-Type -MemberDefinition",
            "'[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
            "-Name NativeMethods -Namespace Win32;",
            "[Win32.NativeMethods]::SetThreadExecutionState(0x80000001);",
            "[Threading.Thread]::Sleep([Threading.Timeout]::Infinite)",
          ].join(" "),
        ],
        label: "Windows power request",
        awakeMessage: "Your machine won't idle-sleep.",
      };
    default:
      return null;
  }
}

function isExecutableAvailable(cmd: string): boolean {
  const pathValue = process.env.PATH;
  if (!pathValue) return false;

  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
      : [""];

  const hasExtension = process.platform === "win32" && /\.[^\\/]+$/.test(cmd);
  const candidates = pathValue
    .split(delimiter)
    .flatMap((directory) =>
      hasExtension
        ? [join(directory, cmd)]
        : extensions.map((extension) => join(directory, `${cmd}${extension}`)),
    );

  return candidates.some((candidate) => existsSync(candidate));
}

function formatElapsed(startTime: number): string {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const hrs = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);
  const secs = elapsed % 60;

  return hrs > 0
    ? `${hrs}h ${mins}m ${secs}s`
    : mins > 0
      ? `${mins}m ${secs}s`
      : `${secs}s`;
}

function clip(text: string, width: number): string {
  return text.length > width ? text.slice(0, Math.max(0, width)) : text;
}

function clipVisiblePlain(text: string, width: number): string {
  let clipped = "";
  let used = 0;
  for (const char of text) {
    const charWidth = visibleWidth(char);
    if (used + charWidth > width) break;
    clipped += char;
    used += charWidth;
  }
  return clipped;
}

function padPlain(text: string, width: number): string {
  const clipped = clip(text, width);
  return clipped + " ".repeat(Math.max(0, width - clipped.length));
}

function padVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function padArtLines(lines: string[]): string[] {
  const artWidth = Math.max(...lines.map((line) => visibleWidth(line)));
  return lines.map((line) => padVisible(line, artWidth));
}

function getOverlayWidth(): number {
  const columns = process.stdout.columns ?? WIDE_INNER_WIDTH + 2;
  return Math.min(WIDE_INNER_WIDTH + 2, Math.max(4, columns - 4));
}

function createTerminalRows(frame: number): string[] {
  const scroll = Math.floor(frame / CODE_REVEAL_STEPS) % TERMINAL_STREAM.length;
  const revealStep = frame % CODE_REVEAL_STEPS;
  const cursor = frame % 4 < 2 ? "|" : " ";

  return Array.from({ length: CODE_ROWS }, (_, row) => {
    const fullLine = TERMINAL_STREAM[(scroll + row) % TERMINAL_STREAM.length];
    if (row !== CODE_ROWS - 1) return padPlain(fullLine, CODE_WIDTH);

    const visibleChars = Math.max(
      1,
      Math.ceil((fullLine.length * (revealStep + 1)) / CODE_REVEAL_STEPS),
    );
    return padPlain(`${fullLine.slice(0, visibleChars)}${cursor}`, CODE_WIDTH);
  });
}

function codeStyle(theme: Theme, text: string): string {
  const trimmed = text.trimStart();
  const lower = trimmed.toLowerCase();
  if (trimmed.startsWith("$") || trimmed.startsWith(">"))
    return theme.fg("accent", text);
  if (
    lower.includes("ok") ||
    lower.includes("brew") ||
    lower.includes("reload")
  ) {
    return theme.fg("success", text);
  }
  if (lower.includes("render")) return theme.fg("syntaxKeyword", text);
  return theme.fg("toolOutput", text);
}

class CaffeinateComponent {
  private tui: TuiHandle;
  private theme: Theme;
  private onClose: () => void;
  private startTime: number;
  private interval: ReturnType<typeof setInterval> | null;
  private frame = 0;
  private cachedLines: string[] = [];
  private cachedWidth = 0;
  private cachedFrame = -1;
  private awakeMessage: string;

  constructor(
    tui: TuiHandle,
    theme: Theme,
    onClose: () => void,
    startTime: number,
    awakeMessage: string,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.onClose = onClose;
    this.startTime = startTime;
    this.awakeMessage = awakeMessage;
    this.interval = setInterval(() => {
      this.frame++;
      this.tui.requestRender();
    }, TICK_MS);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.dispose();
      this.onClose();
    }
  }

  invalidate(): void {
    this.cachedWidth = 0;
  }

  render(width: number): string[] {
    if (width === this.cachedWidth && this.cachedFrame === this.frame)
      return this.cachedLines;

    if (width < 4) {
      this.cachedLines = [" ".repeat(Math.max(0, width))];
      this.cachedWidth = width;
      this.cachedFrame = this.frame;
      return this.cachedLines;
    }

    const t = this.theme;
    const timeStr = formatElapsed(this.startTime);
    const dim = (s: string) => t.fg("dim", s);
    const accent = (s: string) => t.fg("accent", s);
    const muted = (s: string) => t.fg("muted", s);

    const innerWidth = Math.min(WIDE_INNER_WIDTH, width - 2);
    const hBar = "─".repeat(innerWidth);
    const emptyInner = " ".repeat(innerWidth);

    const center = (line: string) => {
      const vw = visibleWidth(line);
      const total = Math.max(0, innerWidth - vw);
      const left = Math.floor(total / 2);
      const right = total - left;
      return " ".repeat(left) + line + " ".repeat(right);
    };

    const artLines =
      innerWidth >= WIDE_ART_MIN_WIDTH
        ? this.renderWideArt(dim, accent, muted, timeStr)
        : this.renderCompactArt(innerWidth, dim, accent, muted, timeStr);

    const lines = [
      dim(`╭${hBar}╮`),
      dim("│") + emptyInner + dim("│"),
      ...artLines.map((line) => dim("│") + center(line) + dim("│")),
      dim("│") + emptyInner + dim("│"),
      dim(`╰${hBar}╯`),
    ];

    this.cachedLines = lines.map((line) => padVisible(line, width));
    this.cachedWidth = width;
    this.cachedFrame = this.frame;
    return this.cachedLines;
  }

  private renderWideArt(
    dim: StyleFn,
    accent: StyleFn,
    muted: StyleFn,
    timeStr: string,
  ): string[] {
    const mugRows = this.renderMug(accent);
    const computerRows = this.renderComputer(dim);
    const textRows = [
      this.theme.bold("Relax and go"),
      this.theme.bold("grab a coffee."),
      "",
      muted(this.awakeMessage),
      `${muted("elapsed")} ${accent(timeStr)}`,
      "",
      `${accent(this.theme.bold("esc"))} ${muted("to stop")}`,
    ];

    const mugWidth = Math.max(...mugRows.map((row) => visibleWidth(row)));
    const computerWidth = Math.max(
      ...computerRows.map((row) => visibleWidth(row)),
    );
    const textWidth = Math.max(...textRows.map((row) => visibleWidth(row)));
    const mugOffset = 5;
    const textOffset = 5;

    return padArtLines(
      computerRows.map((computerRow, index) => {
        const mugRow = mugRows[index - mugOffset] ?? "";
        const textRow = textRows[index - textOffset] ?? "";
        return `${padVisible(mugRow, mugWidth)}  ${padVisible(
          computerRow,
          computerWidth,
        )}   ${padVisible(textRow, textWidth)}`;
      }),
    );
  }

  private renderCompactArt(
    innerWidth: number,
    dim: StyleFn,
    accent: StyleFn,
    muted: StyleFn,
    timeStr: string,
  ): string[] {
    if (innerWidth < 30) {
      const fit = (text: string, style: StyleFn) =>
        style(clipVisiblePlain(text, innerWidth));
      return [
        fit("☕ caffeinated", accent),
        fit(`elapsed ${timeStr}`, muted),
        fit("esc to stop", muted),
      ];
    }

    return [
      ...this.renderMug(accent),
      "",
      ...this.renderComputer(dim),
      "",
      this.theme.bold("Relax and go grab a coffee."),
      muted(this.awakeMessage),
      `${muted("elapsed")} ${accent(timeStr)}`,
      `${accent(this.theme.bold("esc"))} ${muted("to stop")}`,
    ];
  }

  private renderMug(accent: StyleFn): string[] {
    const steam = STEAM_FRAMES[this.frame % STEAM_FRAMES.length];
    return padArtLines([
      accent(steam[0]),
      accent(steam[1]),
      accent(steam[2]),
      accent("     ________ "),
      accent(" .--'--------|"),
      accent("(  c|/\\/\\/\\/\\|"),
      accent(" '-.|/\\/\\/\\/\\|"),
      accent("    '________'"),
      accent("     '------'"),
    ]);
  }

  private renderComputer(dim: StyleFn): string[] {
    const codeRows = createTerminalRows(this.frame);
    const screenLine = (row: number) =>
      `${dim("     ||")}${codeStyle(this.theme, codeRows[row])}${dim("||   |")}`;

    return padArtLines([
      dim("         ______________"),
      dim("        /             /|"),
      dim("       /             / |"),
      dim("      /____________ /  |"),
      dim("     | ___________ |   |"),
      screenLine(0),
      screenLine(1),
      screenLine(2),
      dim("     ||___________||   |"),
      dim("     |   _______   |  /"),
      dim("    /|  (_______)  | /"),
      dim("   ( |_____________|/"),
      dim("    \\"),
      dim(".=======================."),
      dim("| ::::::::::::::::  ::: |"),
      dim("| ::::::::::::::[]  ::: |"),
      dim("|   -----------     ::: |"),
      dim("`-----------------------'"),
    ]);
  }

  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

export default function (pi: ExtensionAPI) {
  const awakeCommand = getAwakeCommand();
  let caffeinateProc: ChildProcess | null = null;
  let startTime: number | null = null;
  let activeComponent: CaffeinateComponent | null = null;

  function kill() {
    const proc = caffeinateProc;
    if (!proc) return;

    if (process.platform === "win32") {
      proc.kill();
    } else {
      proc.kill("SIGTERM");
    }
    const forceKill = setTimeout(() => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      if (process.platform === "win32") {
        proc.kill();
      } else {
        proc.kill("SIGKILL");
      }
    }, 500);
    forceKill.unref?.();

    caffeinateProc = null;
    startTime = null;
  }

  function disposeComponent() {
    activeComponent?.dispose();
    activeComponent = null;
  }

  pi.registerCommand("caffeinate", {
    description: "Toggle caffeinate (keeps your machine awake)",
    handler: async (_args, ctx) => {
      if (caffeinateProc) {
        kill();
        ctx.ui.setStatus("caffeinate", undefined);
        ctx.ui.notify("Caffeinate stopped", "info");
        return;
      }

      if (!awakeCommand) {
        ctx.ui.notify(
          `Caffeinate is not supported on ${process.platform}.`,
          "warning",
        );
        return;
      }

      if (!isExecutableAvailable(awakeCommand.cmd)) {
        ctx.ui.notify(
          `Could not find ${awakeCommand.cmd}; ${awakeCommand.label} is unavailable on this machine.`,
          "warning",
        );
        return;
      }

      caffeinateProc = spawn(awakeCommand.cmd, awakeCommand.args, {
        stdio: "ignore",
        detached: false,
      });
      startTime = Date.now();

      caffeinateProc.on("error", (error) => {
        caffeinateProc = null;
        startTime = null;
        ctx.ui.setStatus("caffeinate", undefined);
        ctx.ui.notify(
          `Could not start ${awakeCommand.label}: ${error.message}`,
          "warning",
        );
      });

      caffeinateProc.on("exit", () => {
        caffeinateProc = null;
        startTime = null;
        ctx.ui.setStatus("caffeinate", undefined);
      });

      ctx.ui.setStatus("caffeinate", "☕ caffeinated");

      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          activeComponent = new CaffeinateComponent(
            tui,
            theme,
            () => {
              activeComponent = null;
              kill();
              ctx.ui.setStatus("caffeinate", undefined);
              ctx.ui.notify("Caffeinate stopped", "info");
              done();
            },
            startTime!,
            awakeCommand.awakeMessage,
          );
          return activeComponent;
        },
        {
          overlay: true,
          overlayOptions: () => ({
            anchor: "center",
            margin: 1,
            width: getOverlayWidth(),
          }),
        },
      );
      activeComponent = null;
    },
  });

  process.once("exit", kill);

  pi.on("session_shutdown", async () => {
    disposeComponent();
    kill();
  });
}
