import { device } from "@shared/device";
import { loadValues, type SettingsValues } from "@shared/settings";
import { textWidth } from "@busy-app/busy-lib";
import manifest from "./appmeta/manifest.json";

/** The name the app draws under; the device clears elements by this id. */
const APP = manifest.id;

type Element = Parameters<typeof device.DisplayDraw>[0]["elements"][number];

const DEFAULT_GAMES = ["Catan", "Ticket to Ride", "Wingspan", "Azul", "Carcassonne", "Codenames", "Splendor", "Pandemic"];
const MAX_GAMES = 50;
/** One per player color, and what fits in the back screen's two columns. */
const MAX_PLAYERS = 8;
const CONFIRM_MS = 4000;
/** How long after BACK the firmware's screen wipe has surely landed. */
const WIPE_MS = 300;
/** Delays between the names the random pick flicks through before it lands. */
const SPIN_MS = [50, 50, 60, 70, 90, 120, 160, 210, 280];

const WHITE = "#FFFFFFFF";
const SUBTLE = "#FFFFFF99";
const DIM = "#FFFFFF55";
const AMBER = "#FFB000FF";
const GREEN = "#00FF60FF";
const RED = "#FF3030FF";
const PLAYER_COLORS = [
  "#FF3030FF",
  "#3080FFFF",
  "#00E060FF",
  "#FFD000FF",
  "#C060FFFF",
  "#FF8000FF",
  "#00E0E0FF",
  "#FF60B0FF",
];

// Literal `font:` properties tell the build which glyph maps to bundle for textWidth().
const TINY = { font: "tiny" } as const;
const SMALL = { font: "small" } as const;
const NORMAL = { font: "normal" } as const;

const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Milliseconds as "M:SS", or "H:MM:SS" from an hour on. */
function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
}

/** Milliseconds as "12m" or "1h05": changes once a minute. */
function formatShort(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${pad2(m % 60)}`;
}

/** Printable ASCII only: the fonts are bitmap ASCII. */
const ascii = (text: string) => text.replace(/[^\x20-\x7E]/g, "?");

/** A comma- or newline-separated setting as a trimmed list. */
function splitList(value: unknown, max: number): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[,\n]/)
    .map((s) => ascii(s.trim()))
    .filter((s) => s.length > 0)
    .slice(0, max);
}

interface Config {
  games: string[];
  players: string[];
  randomFirst: boolean;
  /** 0: no turn alert. */
  turnLimitMs: number;
  backScreen: boolean;
}

function readConfig(values: SettingsValues | null): Config {
  const v = values ?? {};
  const games = typeof v.games === "string" ? splitList(v.games, MAX_GAMES) : DEFAULT_GAMES;
  const limit = v.turn_limit_s;
  return {
    games,
    players: splitList(v.players, MAX_PLAYERS),
    randomFirst: v.random_first !== false,
    turnLimitMs: typeof limit === "number" && isFinite(limit) ? Math.min(Math.max(limit, 0), 3600) * 1000 : 0,
    backScreen: v.back_screen !== false,
  };
}

/** The values object, whether a store hands back `{ values }` or the values themselves. */
function unwrap(doc: unknown): SettingsValues | null {
  if (!doc || typeof doc !== "object") return null;
  const values = (doc as { values?: unknown }).values;
  return (values && typeof values === "object" ? values : doc) as SettingsValues;
}

/** The Settings global first; the HTTP settings endpoint when that has no games list. */
async function readSettings(): Promise<SettingsValues | null> {
  const values = unwrap(await loadValues());
  if (typeof values?.games === "string") return values;
  try {
    return unwrap(await device.AppsSettingsGet({ app_id: APP })) ?? values;
  } catch (err) {
    report(err);
    return values;
  }
}

/** A game in progress. Times on the play clock are ms of play, pauses excluded. */
interface Game {
  name: string;
  players: string[];
  first: number;
  current: number;
  round: number;
  /** Wall time the game started. */
  startMs: number;
  /** Wall time spent paused, finished pauses only. */
  pausedMs: number;
  /** Wall time the clock stopped (paused or ended), or null while it runs. */
  frozenAt: number | null;
  /** Play clock when the current turn began. */
  turnStart: number;
  /** Play time per player, finished turns only. */
  totals: number[];
  /** The turn alert has blinked for this turn. */
  alerted: boolean;
}

/** Play time so far. */
const played = (g: Game) => (g.frozenAt ?? Date.now()) - g.startMs - g.pausedMs;

const random = (n: number) => Math.floor(Math.random() * n);

type Mode = "pick" | "play" | "done";

function main(): void {
  let config = readConfig(null);
  let loaded = false;
  let mode: Mode = "pick";
  let pickIndex = 0;
  let game: Game | null = null;
  /** BACK was pressed once during play: OK ends the game. */
  let confirmEnd = false;
  let led: string | undefined;

  let stopped = false;
  let tickTimer: ReturnType<typeof setTimeout> | null = null;
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;
  let spinTimer: ReturnType<typeof setTimeout> | null = null;
  let wipeTimer: ReturnType<typeof setTimeout> | null = null;

  const paused = () => game !== null && game.frozenAt !== null;
  const playerColor = (i: number) => PLAYER_COLORS[i % PLAYER_COLORS.length];

  /** Turn time while there are players to take turns, else the whole game's. */
  function mainClock(g: Game): number {
    return g.players.length ? played(g) - g.turnStart : played(g);
  }

  function overLimit(g: Game): boolean {
    return config.turnLimitMs > 0 && g.players.length > 0 && mainClock(g) >= config.turnLimitMs;
  }

  // ---- Front screen (72×16) -------------------------------------------------------------

  /** A left-aligned text line that scrolls only when it doesn't fit in `room`. */
  function line(
    id: string,
    text: string,
    color: string,
    x: number,
    y: number,
    room: number,
    font: typeof TINY | typeof SMALL | typeof NORMAL,
    display: "front" | "back" = "front",
  ): Element {
    const el: Element = { id, type: "text", text, ...font, color, x, y, display };
    if (textWidth(text, font.font) > room) {
      Object.assign(el, { width: room, scroll_rate: 600, scroll_start_delay: 3000, scroll_repeat_delay: 5000 });
    }
    return el;
  }

  function rightText(id: string, text: string, color: string, y: number): Element {
    return { id, type: "text", text, ...SMALL, color, x: 72, y, align: "top_right" };
  }

  let cells: { digit: number; colon: number; gap: number } | null = null;

  /** M:SS / H:MM:SS in `small`, right-aligned, one element per character in a fixed-width cell. */
  function clock(text: string, color: string, y: number): { els: Element[]; width: number } {
    if (!cells) {
      let digit = 0;
      for (let d = 0; d <= 9; d++) digit = Math.max(digit, textWidth(String(d), SMALL.font));
      const zero = textWidth("0", SMALL.font);
      cells = { digit, colon: textWidth(":", SMALL.font), gap: Math.max(0, textWidth("00", SMALL.font) - 2 * zero) };
    }
    const c = cells;
    const widths = text.split("").map((ch) => (ch === ":" ? c.colon : c.digit));
    const width = widths.reduce((a, b) => a + b, 0) + c.gap * (text.length - 1);
    // A narrow "1" doesn't shift its neighbours, and ids count from the right so the seconds
    // keep theirs when a digit is added on the left: only the changed digits are resent.
    const els: Element[] = [];
    let x = 72 - width;
    for (let i = 0; i < text.length; i++) {
      els.push({
        id: `c${text.length - 1 - i}`,
        type: "text",
        text: text[i],
        ...SMALL,
        color,
        x: x + Math.floor(widths[i] / 2),
        y,
        align: "top_mid",
      });
      x += widths[i] + c.gap;
    }
    return { els, width };
  }

  // `small` at y=-1 and y=7 lights rows 1–7 and 9–15.
  function front(): Element[] {
    if (!loaded) {
      return [{ id: "msg", type: "text", text: "Loading...", ...SMALL, color: SUBTLE, x: 36, y: 8, align: "center" }];
    }

    if (mode === "pick") {
      if (!config.games.length) {
        return [line("l1", "No games", WHITE, 0, -1, 72, SMALL), line("l2", "Add in settings", DIM, 0, 7, 72, SMALL)];
      }
      const count = `${pickIndex + 1}/${config.games.length}`;
      const out = [line("l1", config.games[pickIndex], WHITE, 0, -1, 72, SMALL), line("l2", count, DIM, 0, 7, 40, SMALL)];
      const n = config.players.length;
      if (n) out.push(rightText("r2", `${n} players`, DIM, 7));
      return out;
    }

    const g = game;
    if (!g) return [];

    if (mode === "done") {
      return [
        line("l1", g.name, WHITE, 0, -1, 72, SMALL),
        line("l2", formatClock(played(g)), SUBTLE, 0, 7, 44, SMALL),
        rightText("r2", `R${g.round}`, DIM, 7),
      ];
    }

    if (confirmEnd) {
      return [line("l1", "End game?", WHITE, 0, -1, 72, SMALL), line("l2", "OK yes BACK no", DIM, 0, 7, 72, SMALL)];
    }

    const timeColor = paused() ? AMBER : overLimit(g) ? RED : WHITE;
    const { els, width } = clock(formatClock(mainClock(g)), timeColor, -1);
    const topRoom = 72 - width - 3;
    const status = paused() ? "Paused" : `R${g.round}`;
    const statusColor = paused() ? AMBER : DIM;

    if (!g.players.length) {
      return [
        ...els,
        line("l1", g.name, WHITE, 0, -1, topRoom, SMALL),
        line("l2", paused() ? "Paused" : `Round ${g.round}`, statusColor, 0, 7, 72, SMALL),
      ];
    }

    const total = formatShort(played(g));
    const bottomRoom = 72 - textWidth(total, SMALL.font) - 3;
    return [
      ...els,
      line("l1", g.players[g.current], playerColor(g.current), 0, -1, topRoom, SMALL),
      line("l2", `${status} ${g.name}`, statusColor, 0, 7, bottomRoom, SMALL),
      rightText("r2", total, SUBTLE, 7),
    ];
  }

  // ---- Back screen (160×80, greyscale) --------------------------------------------------

  /** Back-screen text stops short of the firmware's status icons on the right edge. */
  const BACK_W = 145;

  function back(): Element[] {
    if (!config.backScreen || !loaded) return [];
    const at = (el: Element): Element => ({ ...el, display: "back" });
    const out: Element[] = [];
    let hints: [string, string];

    if (mode === "pick" || !game) {
      out.push(line("b_title", "Game Night", WHITE, 0, 0, BACK_W, NORMAL, "back"));
      if (config.games.length) {
        out.push(line("b_info", `${pickIndex + 1} of ${config.games.length}`, SUBTLE, 0, 14, BACK_W, SMALL, "back"));
      }
      hints = ["KNOB browse  OK play", "START random  BACK quit"];
    } else {
      const g = game;
      out.push(line("b_title", g.name, WHITE, 0, 0, BACK_W, NORMAL, "back"));
      const time = mode === "done" ? formatClock(played(g)) : formatShort(played(g));
      out.push(line("b_info", `Round ${g.round}   ${time}`, SUBTLE, 0, 12, BACK_W, SMALL, "back"));
      // Two columns of four: name on the left, play time on the right.
      g.players.forEach((name, i) => {
        const x = i < 4 ? 0 : 76;
        const y = 22 + (i % 4) * 9;
        const now = mode === "play" && i === g.current;
        const color = now ? WHITE : SUBTLE;
        // Totals change only when a turn ends, so seconds cost no extra draws.
        const t = formatClock(g.totals[i]);
        const tw = textWidth(t, SMALL.font);
        out.push(line(`b_p${i}`, `${now ? ">" : ""}${name}`, color, x, y, 66 - tw, SMALL, "back"));
        out.push(at({ id: `b_t${i}`, type: "text", text: t, ...SMALL, color, x: x + 68, y, align: "top_right" }));
      });
      hints =
        mode === "done"
          ? ["OK/BACK new game", "START play again"]
          : ["OK next turn  KNOB fix turn", "START pause  BACK end game"];
    }

    out.push(at({ id: "b_hint1", type: "text", text: hints[0], ...TINY, color: DIM, x: 0, y: 64 }));
    out.push(at({ id: "b_hint2", type: "text", text: hints[1], ...TINY, color: DIM, x: 0, y: 72 }));
    return out;
  }

  // ---- Drawing: only changed elements are sent ------------------------------------------

  let shown = new Map<string, string>();
  let drawing = false;
  let redrawPending = false;
  /** Resend every element on the next draw: the firmware wiped the screen. */
  let resendAll = false;

  async function draw(): Promise<void> {
    if (stopped) return;
    if (drawing) {
      redrawPending = true;
      return;
    }
    drawing = true;
    try {
      if (resendAll) {
        resendAll = false;
        shown = new Map();
      }
      if (game && mode === "play" && !paused() && !game.alerted && overLimit(game)) {
        game.alerted = true;
        led = RED;
      }
      const elements = [...front(), ...back()];
      const next = new Map<string, string>();
      const changed: Element[] = [];
      for (const el of elements) {
        const json = JSON.stringify(el);
        next.set(el.id, json);
        if (shown.get(el.id) !== json) changed.push(el);
      }
      const removed = [...shown.keys()].filter((id) => !next.has(id));
      if (removed.length) await device.DisplayClear({ application_name: APP, element_ids: removed });
      const blink = led;
      led = undefined;
      if (changed.length || blink) {
        await device.DisplayDraw({
          application_name: APP,
          priority: 50,
          elements: changed,
          ...(blink ? { led_notification_color: blink } : {}),
        });
      }
      shown = next;
    } catch (err) {
      // Screen state is unknown: resend everything next time.
      shown = new Map();
      throw err;
    } finally {
      drawing = false;
      if (redrawPending && !stopped) {
        redrawPending = false;
        void draw().catch(report);
      } else {
        scheduleTick();
      }
    }
  }

  const redraw = () => void draw().catch(report);

  /**
   * The firmware clears the app's elements when BACK is pressed (it expects the app to quit), and
   * that can land after the redraw BACK caused: draw the whole frame again once it has.
   */
  function redrawAfterBack(): void {
    if (wipeTimer) clearTimeout(wipeTimer);
    wipeTimer = setTimeout(() => {
      wipeTimer = null;
      resendAll = true;
      redraw();
    }, WIPE_MS);
  }

  /** While the clock runs on screen, redraw just after its seconds next change. */
  function scheduleTick(): void {
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = null;
    const g = game;
    if (stopped || mode !== "play" || !g || paused() || confirmEnd) return;
    const ms = 1000 - (mainClock(g) % 1000) + 30;
    tickTimer = setTimeout(() => {
      tickTimer = null;
      redraw();
    }, ms);
  }

  // ---- Picking --------------------------------------------------------------------------

  async function loadConfig(): Promise<void> {
    config = readConfig(await readSettings());
    loaded = true;
    pickIndex = Math.min(pickIndex, Math.max(0, config.games.length - 1));
  }

  function toPicker(): void {
    mode = "pick";
    game = null;
    // Pick up settings edited since the last game.
    void loadConfig()
      .catch(report)
      .then(redraw);
  }

  function movePick(delta: number): void {
    const n = config.games.length;
    if (!n) return;
    pickIndex = (pickIndex + delta + n) % n;
    redraw();
  }

  /** Flick through random games, slowing down, and land on the last. */
  function spin(): void {
    const n = config.games.length;
    if (n < 2 || spinTimer) return;
    let step = 0;
    const flick = () => {
      let next = random(n);
      if (next === pickIndex) next = (next + 1) % n;
      pickIndex = next;
      if (step === SPIN_MS.length) {
        spinTimer = null;
        led = GREEN;
        redraw();
        return;
      }
      redraw();
      spinTimer = setTimeout(flick, SPIN_MS[step++]);
    };
    flick();
  }

  // ---- Playing --------------------------------------------------------------------------

  function startGame(name: string): void {
    const players = config.players;
    const first = players.length && config.randomFirst ? random(players.length) : 0;
    game = {
      name,
      players,
      first,
      current: first,
      round: 1,
      startMs: Date.now(),
      pausedMs: 0,
      frozenAt: null,
      turnStart: 0,
      totals: players.map(() => 0),
      alerted: false,
    };
    mode = "play";
    confirmEnd = false;
    led = players.length ? playerColor(first) : GREEN;
    redraw();
  }

  /** Move the turn by one seat: +1 ends the turn, -1 corrects a turn ended by mistake. */
  function turn(delta: 1 | -1): void {
    const g = game;
    if (!g) return;
    const now = played(g);
    const n = g.players.length;
    if (!n) {
      // No players: OK just counts rounds.
      g.round = Math.max(1, g.round + delta);
    } else {
      g.totals[g.current] += now - g.turnStart;
      if (delta < 0 && g.current === g.first) g.round = Math.max(1, g.round - 1);
      g.current = (g.current + delta + n) % n;
      if (delta > 0 && g.current === g.first) g.round += 1;
      led = playerColor(g.current);
    }
    g.turnStart = now;
    g.alerted = false;
    redraw();
  }

  function togglePause(): void {
    const g = game;
    if (!g) return;
    const now = Date.now();
    if (g.frozenAt === null) {
      g.frozenAt = now;
      led = AMBER;
    } else {
      g.pausedMs += now - g.frozenAt;
      g.frozenAt = null;
    }
    redraw();
  }

  function askEnd(): void {
    confirmEnd = true;
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = setTimeout(cancelEnd, CONFIRM_MS);
    redraw();
  }

  function cancelEnd(): void {
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = null;
    confirmEnd = false;
    redraw();
  }

  function endGame(): void {
    const g = game;
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = null;
    confirmEnd = false;
    if (!g) return;
    if (g.frozenAt === null) g.frozenAt = Date.now();
    if (g.players.length) g.totals[g.current] += played(g) - g.turnStart;
    mode = "done";
    led = GREEN;
    redraw();
  }

  // ---- Lifecycle ------------------------------------------------------------------------

  void loadConfig()
    .catch(report)
    .then(() => {
      loaded = true;
      redraw();
    });

  const unbind = listen("input", (event) => {
    if (stopped) return;
    handle(event);
    if (!stopped && event.key === "back" && event.action === "short") redrawAfterBack();
  });

  function handle(event: BusyInputEvent): void {

    if (event.key === "encoder") {
      if (mode === "pick" && !spinTimer) movePick(event.delta);
      else if (mode === "play" && !confirmEnd) turn(event.delta);
      return;
    }
    if (event.action !== "short") return;

    if (mode === "pick") {
      if (event.key === "back") return quit();
      else if (spinTimer) return;
      else if (event.key === "start") spin();
      else if (event.key === "ok" && config.games.length) startGame(config.games[pickIndex]);
      return;
    }

    if (mode === "done") {
      if (event.key === "start" && game) startGame(game.name);
      else toPicker();
      return;
    }

    if (confirmEnd) {
      if (event.key === "ok") endGame();
      else cancelEnd();
      return;
    }
    if (event.key === "back") askEnd();
    else if (event.key === "start") togglePause();
    else if (event.key === "ok") {
      // OK while paused just resumes, so a stray press doesn't skip anyone.
      if (paused()) togglePause();
      else turn(1);
    }
  }

  function quit(): void {
    stopped = true;
    for (const t of [tickTimer, confirmTimer, spinTimer, wipeTimer]) if (t) clearTimeout(t);
    // The listener is the last handle: unbind after this callback returns.
    setTimeout(unbind, 0);
  }
}

main();
