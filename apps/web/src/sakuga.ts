// The Sakuga style's press effects: every .btn throws drawn anime effects when tapped, using the vendored Sakuga VFX
// core (one fixed canvas over the page, pointer-events none). Loaded only once the Sakuga style is chosen.
import "./vendor/sakuga-core.js";

type Pt = { x: number; y: number; w: number; h: number };
const fx = (window as unknown as { SakugaFX: Record<string, (...a: never[]) => unknown> }).SakugaFX as unknown as {
  at: (el: Element) => Pt;
  burst: (x: number, y: number, o?: object) => void; puff: (x: number, y: number, o?: object) => void;
  ticks: (x: number, y: number, o?: object) => void; wob: (x: number, y: number, o?: object) => void;
  sfx: (name: string, x: number, y: number, o?: object) => void; rnd: (a: number, b?: number) => number;
};

document.addEventListener("click", (e) => {
  if (document.documentElement.dataset.skin !== "sakuga") return;
  const b = (e.target as Element | null)?.closest?.(".btn");
  if (!b || (b as HTMLButtonElement).disabled) return;
  const c = fx.at(b);
  if (b.classList.contains("btn-accent")) {
    // The main action of a screen: an impact burst, smoke off the corners and ドン!
    fx.burst(c.x, c.y, { r: Math.min(80, Math.max(c.w, c.h) * 0.7), spikes: 15, life: 0.42 });
    for (const [dx, dy] of [[-1, -0.6], [1, -0.8], [-1, 0.8], [1, 0.7]]) fx.puff(c.x + dx * (c.w / 2 + 4), c.y + dy * (c.h / 2), { size: fx.rnd(9, 13), n: 5, vx: dx * 40, vy: dy * 24 - 6, life: fx.rnd(0.6, 0.85) });
    fx.sfx("don", c.x + 6, c.y - c.h / 2 - 34, { size: 120, life: 0.9 });
  } else {
    // Everything else: a small kick, three wedges above and a wobble either side.
    fx.ticks(c.x, c.y - c.h / 2 - 6, { dir: -Math.PI / 2, n: 3, r: 4, len: 14, fan: 0.5 });
    fx.wob(c.x - c.w / 2 - 6, c.y, { dir: -1, r: 10, life: 0.3 });
    fx.wob(c.x + c.w / 2 + 6, c.y, { dir: 1, r: 10, life: 0.3 });
  }
}, true);
