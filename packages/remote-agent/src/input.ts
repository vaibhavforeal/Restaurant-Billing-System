// Remote input on Windows: the viewer's messages, checked, turned into real mouse and keyboard events with SendInput (through koffi).
// Runs in the main process as the signed-in Windows user, so it reaches what that user can: not UAC prompts, the lock screen, or
// windows of elevated programs (Windows blocks that on purpose).
import type { InputMessage } from "./protocol.js";
import { scanKey } from "./keys.js";

export interface Bounds { x: number; y: number; width: number; height: number }

/** A viewer's message, only if it is exactly one of the allowed shapes with sane values. */
export function parseInput(raw: unknown): InputMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const fraction = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  switch (m["t"]) {
    case "move": return fraction(m["x"]) && fraction(m["y"]) ? { t: "move", x: m["x"] as number, y: m["y"] as number } : null;
    case "button": return (m["button"] === 0 || m["button"] === 1 || m["button"] === 2) && typeof m["down"] === "boolean" && fraction(m["x"]) && fraction(m["y"])
      ? { t: "button", button: m["button"], down: m["down"], x: m["x"] as number, y: m["y"] as number } : null;
    case "wheel": return (m["dx"] === -1 || m["dx"] === 0 || m["dx"] === 1) && (m["dy"] === -1 || m["dy"] === 0 || m["dy"] === 1) ? { t: "wheel", dx: m["dx"], dy: m["dy"] } : null;
    case "key": return typeof m["code"] === "string" && m["code"].length <= 32 && scanKey(m["code"]) !== null && typeof m["down"] === "boolean" ? { t: "key", code: m["code"], down: m["down"] } : null;
    case "screen": return Number.isInteger(m["index"]) && (m["index"] as number) >= 0 && (m["index"] as number) < 16 ? { t: "screen", index: m["index"] as number } : null;
    default: return null;
  }
}

/** A fraction of the shared display to a point in its own (DIP) coordinates; the caller converts DIP to physical pixels. */
export function pointOn(bounds: Bounds, x: number, y: number): { x: number; y: number } {
  // Floored: the far edge is the screen's last pixel, not the first pixel of the screen beside it.
  return { x: bounds.x + Math.min(Math.floor(x * bounds.width), bounds.width - 1), y: bounds.y + Math.min(Math.floor(y * bounds.height), bounds.height - 1) };
}

export interface Injector {
  /** Physical screen pixels. */
  moveTo(x: number, y: number): void;
  button(button: 0 | 1 | 2, down: boolean): void;
  wheel(dx: number, dy: number): void;
  key(code: string, down: boolean): void;
  /** Lets go of every key and button this session pressed and didn't release, so nothing stays stuck down. */
  releaseAll(): void;
}

const INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
const MOUSE = { leftDown: 0x0002, leftUp: 0x0004, rightDown: 0x0008, rightUp: 0x0010, middleDown: 0x0020, middleUp: 0x0040, wheel: 0x0800, hwheel: 0x1000 };
const KEY = { extended: 0x0001, up: 0x0002, scancode: 0x0008 };
const WHEEL_DELTA = 120;

/** The real thing, on Windows. Loading koffi is deferred to the first session, so a PC that never shares never loads it. */
export async function windowsInjector(): Promise<Injector> {
  const koffi = (await import("koffi")).default;
  const user32 = koffi.load("user32.dll");
  const MOUSEINPUT = koffi.struct("MOUSEINPUT", { dx: "long", dy: "long", mouseData: "uint32", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr_t" });
  const KEYBDINPUT = koffi.struct("KEYBDINPUT", { wVk: "uint16", wScan: "uint16", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr_t" });
  const HARDWAREINPUT = koffi.struct("HARDWAREINPUT", { uMsg: "uint32", wParamL: "uint16", wParamH: "uint16" });
  const INPUT = koffi.struct("INPUT", { type: "uint32", u: koffi.union("INPUT_UNION", { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }) });
  const SendInput = user32.func("uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)");
  const SetCursorPos = user32.func("int __stdcall SetCursorPos(int X, int Y)");
  const size = koffi.sizeof(INPUT);

  const mouse = (dwFlags: number, mouseData = 0) => SendInput(1, [{ type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData, dwFlags, time: 0, dwExtraInfo: 0 } } }], size);
  const pressedKeys = new Set<string>(), pressedButtons = new Set<0 | 1 | 2>();
  const buttonFlags = (button: 0 | 1 | 2, down: boolean) =>
    button === 0 ? (down ? MOUSE.leftDown : MOUSE.leftUp) : button === 2 ? (down ? MOUSE.rightDown : MOUSE.rightUp) : (down ? MOUSE.middleDown : MOUSE.middleUp);
  const key = (code: string, down: boolean) => {
    const k = scanKey(code);
    if (!k) return;
    SendInput(1, [{ type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: k.scan, dwFlags: KEY.scancode | (k.extended ? KEY.extended : 0) | (down ? 0 : KEY.up), time: 0, dwExtraInfo: 0 } } }], size);
    if (down) pressedKeys.add(code); else pressedKeys.delete(code);
  };
  return {
    moveTo: (x, y) => { SetCursorPos(Math.round(x), Math.round(y)); },
    button: (button, down) => { mouse(buttonFlags(button, down)); if (down) pressedButtons.add(button); else pressedButtons.delete(button); },
    // Unsigned 32-bit: a negative wheel step is sent as its two's complement.
    wheel: (dx, dy) => { if (dy) mouse(MOUSE.wheel, (-dy * WHEEL_DELTA) >>> 0); if (dx) mouse(MOUSE.hwheel, (dx * WHEEL_DELTA) >>> 0); },
    key,
    releaseAll: () => {
      for (const code of [...pressedKeys]) key(code, false);
      for (const button of [...pressedButtons]) { mouse(buttonFlags(button, false)); pressedButtons.delete(button); }
    },
  };
}
