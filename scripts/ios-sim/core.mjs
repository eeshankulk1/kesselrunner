// Pure helpers for iosim: turning AXe's accessibility tree into a listing an
// agent can afford to read (the raw tree runs to ~0.5 MB a screen, the
// listing to a few KB), finding elements in it, and naming the throwaway
// simulators iosim creates so it can refuse to delete any other.

// Controls whose own label already says what their text and icon children say.
const CONTROLS = new Set(["Button", "Link", "PopUpButton", "RadioButton", "Switch", "CheckBox", "MenuItem", "Tab"]);
const LABEL_MAX = 60;

const round = (n) => Math.round(n ?? 0);
const clip = (s) => (s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1)}…` : s);

/** The tree's root node: AXe prints `[application]`, `--point` prints one node. */
export function rootOf(tree) {
  return Array.isArray(tree) ? tree[0] ?? null : tree ?? null;
}

/**
 * Every node that carries a label, id or value, in reading order:
 * { type, id, label, value, enabled, x, y, w, h, onScreen, cx, cy, inControl }.
 * cx,cy is the centre of the part that is on screen: a point a tap can use.
 */
export function flatten(tree) {
  const root = rootOf(tree);
  if (!root) return { screen: null, nodes: [] };
  const sf = root.frame ?? {};
  const screen = root.type === "Application" ? { w: round(sf.width), h: round(sf.height) } : null;
  const nodes = [];
  const walk = (n, inControl) => {
    const f = n.frame ?? {};
    const [x, y, w, h] = [f.x ?? 0, f.y ?? 0, f.width ?? 0, f.height ?? 0];
    const label = typeof n.AXLabel === "string" ? n.AXLabel.trim() : "";
    const id = typeof n.AXUniqueId === "string" ? n.AXUniqueId : "";
    const value = n.AXValue == null ? "" : String(n.AXValue).trim();
    if (n !== root || !screen) {
      const [x0, y0] = [Math.max(x, 0), Math.max(y, 0)];
      const [x1, y1] = screen ? [Math.min(x + w, screen.w), Math.min(y + h, screen.h)] : [x + w, y + h];
      const onScreen = w > 0 && h > 0 && x1 > x0 && y1 > y0;
      if (label || id || value) {
        nodes.push({
          type: n.type ?? "Unknown", id, label, value, enabled: n.enabled !== false,
          x: round(x), y: round(y), w: round(w), h: round(h), onScreen, inControl,
          cx: round(onScreen ? (x0 + x1) / 2 : x + w / 2), cy: round(onScreen ? (y0 + y1) / 2 : y + h / 2),
        });
      }
    }
    const below = inControl || (CONTROLS.has(n.type) && Boolean(label));
    for (const c of n.children ?? []) walk(c, below);
  };
  walk(root, false);
  return { screen, nodes };
}

/** One line per element: `Button #menu-settings "Settings" @46,807`. */
export function line(n) {
  let s = n.type;
  if (n.id) s += ` #${n.id}`;
  if (n.label) s += ` ${JSON.stringify(clip(n.label))}`;
  if (n.value && n.value !== n.label) s += ` =${JSON.stringify(clip(n.value))}`;
  if (!n.enabled) s += " (disabled)";
  return `${s} @${n.cx},${n.cy}`;
}

// Noise an agent never acts on: scroll indicators, list bullets, icons that
// only repeat their symbol name, and the text and icons inside a labelled
// control (the control's label already carries them).
function isNoise(n) {
  if (/scroll bar/i.test(n.label)) return true;
  if (n.label && !/[\p{L}\p{N}]/u.test(n.label) && !n.id) return true;
  if (n.type === "Image" && (!n.label || n.label === n.id)) return true;
  return n.inControl && (n.type === "StaticText" || n.type === "Image");
}

/**
 * The listing: { screen, lines, offScreen }. Off-screen elements are counted,
 * not listed. An element under another view (a screen pushed over it, a
 * drawer) IS listed: frames cannot tell covered from visible, so a listing
 * says what exists, and only a screenshot or a hit test says what shows.
 */
export function compact(tree, { all = false, grep = null } = {}) {
  const { screen, nodes } = flatten(tree);
  const lines = [];
  let offScreen = 0;
  for (const n of nodes) {
    if (!all && !n.onScreen) { offScreen += 1; continue; }
    if (!all && isNoise(n)) continue;
    const text = line(n) + (all && !n.onScreen ? " (off-screen)" : "");
    if (grep && !grep.test(text)) continue;
    if (lines.at(-1) !== text) lines.push(text);
  }
  return { screen, lines, offScreen };
}

/** On-screen elements matching { id } or { label } exactly, or { text } anywhere in label or value (case-insensitive). */
export function find(tree, { id, label, text }) {
  const needle = text?.toLowerCase();
  return flatten(tree).nodes.filter((n) => n.onScreen && (
    (id !== undefined && n.id === id)
    || (label !== undefined && n.label === label)
    || (needle !== undefined && `${n.label}\n${n.value}`.toLowerCase().includes(needle))
  ));
}

// ------------------------------------------------------ throwaway simulators
const SIM_NAME = /^iosim-(\d+)-\d+$/;

/** `iosim-<epoch seconds>-<pid>`: the name says who made it and when. */
export const simName = (nowMs, pid) => `iosim-${Math.floor(nowMs / 1000)}-${pid}`;

export const isOurSim = (name) => SIM_NAME.test(name ?? "");

/** [{ name, udid, state, runtime }] out of `xcrun simctl list -j devices`. */
export function devicesOf(list) {
  return Object.entries(list?.devices ?? {}).flatMap(([runtime, ds]) => ds.map((d) => ({ name: d.name, udid: d.udid, state: d.state, runtime })));
}

/** Simulators iosim created more than maxAgeS ago: a run that died before its teardown. */
export function staleSims(devices, nowMs, maxAgeS) {
  return devices.filter((d) => {
    const m = SIM_NAME.exec(d.name ?? "");
    return m && nowMs / 1000 - Number(m[1]) > maxAgeS;
  });
}

/**
 * The newest available iOS runtime (or the one matching `want` by version,
 * name or identifier) and the first of `names` it supports:
 * { runtime, deviceType, deviceName } or { error }.
 */
export function pickDevice(list, names, want) {
  const runtimes = (list?.runtimes ?? []).filter((r) => r.isAvailable && r.platform === "iOS"
    && (!want || [r.identifier, r.version, r.name].includes(want)));
  if (!runtimes.length) return { error: `no available iOS runtime${want ? ` matching ${want}` : ""}` };
  const key = (r) => r.version.split(".").map(Number);
  const runtime = runtimes.reduce((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    for (let i = 0; i < Math.max(ka.length, kb.length); i += 1) {
      if ((ka[i] ?? 0) !== (kb[i] ?? 0)) return (ka[i] ?? 0) > (kb[i] ?? 0) ? a : b;
    }
    return a;
  });
  const supported = new Map((runtime.supportedDeviceTypes ?? []).map((t) => [t.name, t.identifier]));
  const deviceName = names.find((n) => supported.has(n));
  if (!deviceName) return { error: `none of ${names.join(", ")} on ${runtime.name}` };
  return { runtime, deviceType: supported.get(deviceName), deviceName };
}
