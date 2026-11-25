/*!
 * Liquid Glass refraction for the Glass style, ported from the Angular directive in
 * https://github.com/stormaref/LiquidGlassSkill (MIT, Copyright (c) 2026 Aref Azizian).
 *
 * The refraction field is a port of the fragment shader in liquid-glass-js
 * (https://github.com/dashersw/liquid-glass-js) — Copyright (c) 2025 Armagan
 * Amcalar, MIT. Permission is hereby granted, free of charge, to any person
 * obtaining a copy of that software to deal in it without restriction,
 * provided this notice travels with it; it is provided "as is", without
 * warranty of any kind. Keep this header on any copy or port.
 *
 * Instead of a per-element directive, one watcher finds every `.card` while the Glass style is on and points its
 * backdrop-filter at a displacement filter baked for its size (feImage → feDisplacementMap → feGaussianBlur).
 * Chromium only (Fully Kiosk's WebView is Chromium); elsewhere the stylesheet's blur fallback stays.
 */
const GLASS_PRESET = {
  edgeIntensity: 0.015, rimIntensity: 0.028, baseIntensity: 0.05,
  edgeDistance: 0.5, rimDistance: 1.7, baseDistance: 0.2,
  cornerBoost: 0.06, rippleEffect: 0.26, blurRadius: 2, warp: false,
};
type Cfg = typeof GLASS_PRESET;
const SUPERSAMPLE = 2, MAX_MAP_EDGE = 1400, BLUR_STD_PER_RADIUS = 0.35;
const svgNs = "http://www.w3.org/2000/svg";

const supported = () => {
  const brands = (navigator as unknown as { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands;
  return brands ? brands.some((b) => /Chromium|Google Chrome|Microsoft Edge/i.test(b.brand)) : /Chrome\//.test(navigator.userAgent);
};

const filters = new Map<string, { id: string; node: SVGFilterElement; refs: number }>();
const live = new Map<HTMLElement, string | null>(); // card → key of the filter it uses
let defs: SVGSVGElement | null = null, nextId = 0, raf = 0, debounce: ReturnType<typeof setTimeout> | undefined;
let ro: ResizeObserver | null = null, mo: MutationObserver | null = null;

const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => live.forEach((_, el) => rebuild(el))); };
const onWindowResize = () => { clearTimeout(debounce); debounce = setTimeout(schedule, 180); };

/** Pick up cards React added or removed. */
function scan() {
  const cards = new Set(document.querySelectorAll<HTMLElement>(".card"));
  live.forEach((_, el) => { if (!cards.has(el)) { ro!.unobserve(el); release(el); live.delete(el); } });
  cards.forEach((el) => { if (!live.has(el)) { live.set(el, null); ro!.observe(el); } });
  schedule();
}

export function startGlass() {
  if (mo || !supported()) return;
  ro = new ResizeObserver(schedule);
  mo = new MutationObserver(scan);
  mo.observe(document.body, { childList: true, subtree: true });
  addEventListener("resize", onWindowResize, { passive: true });
  scan();
}

export function stopGlass() {
  mo?.disconnect(); ro?.disconnect(); mo = ro = null;
  removeEventListener("resize", onWindowResize); clearTimeout(debounce); cancelAnimationFrame(raf);
  live.forEach((_, el) => { release(el); el.style.backdropFilter = ""; });
  live.clear();
}

function rebuild(el: HTMLElement) {
  const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
  if (w < 2 || h < 2) return;
  const cs = getComputedStyle(el).borderTopLeftRadius, rv = parseFloat(cs) || 0;
  const radius = Math.min(cs.trim().endsWith("%") ? (rv / 100) * Math.min(w, h) : rv, Math.min(w, h) / 2);
  const key = [w, h, radius, innerWidth, innerHeight].join("|");
  if (key === live.get(el)) return;
  release(el);
  const entry = acquire(key, w, h, radius, innerWidth, innerHeight, GLASS_PRESET);
  live.set(el, key);
  el.style.backdropFilter = `url(#${entry.id})`;
}

function release(el: HTMLElement) {
  const key = live.get(el); if (!key) return;
  live.set(el, null);
  const e = filters.get(key);
  if (e && --e.refs <= 0) { filters.delete(key); e.node.remove(); }
}

/** Same-size cards share one filter. */
function acquire(key: string, w: number, h: number, radius: number, pageW: number, pageH: number, cfg: Cfg) {
  let entry = filters.get(key);
  if (entry && entry.node.isConnected) { entry.refs++; return entry; }
  if (entry) filters.delete(key);
  const { mapUrl, scale } = buildDisplacementMap(w, h, radius, pageW, pageH, cfg);
  const id = `liquid-glass-${nextId++}`;
  const filter = document.createElementNS(svgNs, "filter");
  // The region must extend past the box by the largest offset plus the blur spread, or corners clip.
  const margin = scale / 2 + 3 * cfg.blurRadius * BLUR_STD_PER_RADIUS, mx = (margin / w) * 100, my = (margin / h) * 100;
  for (const [k, v] of [["id", id], ["x", `${-mx}%`], ["y", `${-my}%`], ["width", `${100 + 2 * mx}%`], ["height", `${100 + 2 * my}%`], ["color-interpolation-filters", "sRGB"]]) filter.setAttribute(k, v);
  const img = document.createElementNS(svgNs, "feImage");
  for (const [k, v] of [["href", mapUrl], ["x", "0"], ["y", "0"], ["width", String(w)], ["height", String(h)], ["preserveAspectRatio", "none"], ["result", "map"]]) img.setAttribute(k, v);
  const disp = document.createElementNS(svgNs, "feDisplacementMap");
  for (const [k, v] of [["in", "SourceGraphic"], ["in2", "map"], ["scale", String(scale)], ["xChannelSelector", "R"], ["yChannelSelector", "G"], ["result", "displaced"]]) disp.setAttribute(k, v);
  const blur = document.createElementNS(svgNs, "feGaussianBlur");
  blur.setAttribute("in", "displaced"); blur.setAttribute("stdDeviation", String(cfg.blurRadius * BLUR_STD_PER_RADIUS));
  filter.append(img, disp, blur);
  if (!defs || !defs.isConnected) {
    defs = document.createElementNS(svgNs, "svg");
    defs.setAttribute("width", "0"); defs.setAttribute("height", "0"); defs.setAttribute("aria-hidden", "true");
    defs.style.position = "fixed";
    defs.appendChild(document.createElementNS(svgNs, "defs"));
    document.body.appendChild(defs);
  }
  defs.querySelector("defs")!.appendChild(filter);
  entry = { id, node: filter, refs: 1 };
  filters.set(key, entry);
  return entry;
}

/** Bake the refraction field into R/G around neutral; formulas transcribed 1:1 from the reference. */
export function buildDisplacementMap(w: number, h: number, radius: number, pageW: number, pageH: number, cfg: Cfg) {
  const ss = Math.max(0.25, Math.min(SUPERSAMPLE, MAX_MAP_EDGE / Math.max(w, h)));
  const bw = Math.max(1, Math.round(w * ss)), bh = Math.max(1, Math.round(h * ss)), r = radius * ss, minDim = Math.min(w, h);
  const dx = new Float32Array(bw * bh), dy = new Float32Array(bw * bh);
  let maxAbs = 0;
  for (let py = 0; py < bh; py++) for (let px = 0; px < bw; px++) {
    const cx = (px + 0.5) / bw, cy = (py + 0.5) / bh;
    const tx = Math.abs(px + 0.5 - bw / 2) - (bw / 2 - r), ty = Math.abs(py + 0.5 - bh / 2) - (bh / 2 - r);
    const distPx = Math.max(-(Math.hypot(Math.max(tx, 0), Math.max(ty, 0)) + Math.min(Math.max(tx, ty), 0) - r), 0) / ss;
    const edgeFall = Math.exp(-distPx * cfg.edgeDistance), rimFall = Math.exp(-distPx * cfg.rimDistance);
    const base = cfg.warp ? (1 - Math.exp(-distPx * cfg.baseDistance)) * cfg.baseIntensity : 0;
    const total = base + edgeFall * cfg.edgeIntensity + rimFall * cfg.rimIntensity;
    let nx = cx - 0.5, ny = cy - 0.5; const len = Math.hypot(nx, ny); if (len > 0) { nx /= len; ny /= len; }
    const corner = Math.exp(-Math.max(Math.min(cx, 1 - cx), Math.min(cy, 1 - cy)) * minDim * 0.3) * cfg.cornerBoost;
    const ripple = Math.sin((distPx / minDim) * 25) * cfg.rippleEffect * rimFall;
    const i = py * bw + px;
    dx[i] = (nx * (total + corner) - ny * ripple) * pageW;
    dy[i] = (ny * (total + corner) + nx * ripple) * pageH;
    maxAbs = Math.max(maxAbs, Math.abs(dx[i]), Math.abs(dy[i]));
  }
  const scale = Math.max(maxAbs * 2, 1e-4), bias = scale * (128 / 255 - 0.5); // 128 decodes to +scale/510, not 0
  const canvas = document.createElement("canvas"); canvas.width = bw; canvas.height = bh;
  const ctx = canvas.getContext("2d")!, image = ctx.createImageData(bw, bh), data = image.data;
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  for (let i = 0; i < bw * bh; i++) {
    data[i * 4] = byte(255 * (0.5 + (dx[i] - bias) / scale));
    data[i * 4 + 1] = byte(255 * (0.5 + (dy[i] - bias) / scale));
    data[i * 4 + 2] = 128; data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return { mapUrl: canvas.toDataURL("image/png"), scale };
}
