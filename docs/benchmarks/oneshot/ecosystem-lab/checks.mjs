// Ecosystem Lab hidden checks (spec docs/superpowers/specs/2026-10-07-oneshot-bench-design.md §2).
// usage: node checks.mjs --app APP.html --ref reference.html --params PARAMS.json --out OUT.json [--shots DIR] [--only ID,ID]
// Simulation checks compare the app with the reference live, on the same inputs. Rendering, chart, data and UI checks
// compare the app with its own state, so a simulation bug is counted once, in its own areas. Each check gets a fresh
// browser context; every request outside the local server is aborted and counted.
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const require = createRequire(path.resolve(process.cwd(), "x.js"));
let chromium;
try { ({ chromium } = require("playwright")); }
catch { ({ chromium } = createRequire(new URL("../../../../scripts/oneshot/package.json", import.meta.url))("playwright")); }

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
  return acc;
}, []));
const P = JSON.parse(fs.readFileSync(args.params, "utf8"));
const FILES = { "/app.html": path.resolve(args.app), "/ref.html": path.resolve(args.ref) };
const DEF = { width: 40, height: 30, grassMax: 4, rabbits0: 100, foxes0: 6 };
const TIMEOUT = 20000;

const server = http.createServer((req, res) => {
  const f = FILES[req.url.split("?")[0]];
  if (!f) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
let blocked = 0;

async function open(file, { width = 1280, height = 900, clock = false, context = null } = {}) {
  const ctx = context || await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, acceptDownloads: true });
  if (!context) await ctx.route("**/*", route => {
    if (route.request().url().startsWith(BASE)) return route.continue();
    blocked += 1;
    return route.abort();
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e).slice(0, 300)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
  if (clock) await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.goto(`${BASE}/${file}`, { waitUntil: "load" });
  return { page, ctx, errors };
}

const ref = await open("ref.html");
const R = (fn, arg) => ref.page.evaluate(fn, arg);

// ---- in-page helpers (passed to evaluate) ----
const dumpFn = ([W, H]) => {
  const out = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = window.lab.cell(x, y);
    out.push([c.grass, c.rabbit ? c.rabbit.id : 0, c.rabbit ? c.rabbit.energy : 0, c.fox ? c.fox.id : 0, c.fox ? c.fox.energy : 0].join(","));
  }
  return out;
};
const dims = params => [params.width || DEF.width, params.height || DEF.height];
const sameCounts = (a, b) => a && b && a.rabbits === b.rabbits && a.foxes === b.foxes && a.grass === b.grass;
const fmt = o => JSON.stringify(o);
function firstDiff(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return `length ${a && a.length} vs ${b.length}`;
  const i = a.findIndex((v, k) => v !== b[k]);
  return i < 0 ? null : `cell #${i}: app ${a[i]} vs reference ${b[i]}`;
}
const tid = (page, id) => page.locator(`[data-testid="${id}"]`).first();
const setRange = (page, id, v) => page.evaluate(([id, v]) => {
  const el = document.querySelector(`[data-testid="${id}"]`);
  el.value = String(v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}, [id, v]);
const setField = (page, id, v) => page.evaluate(([id, v]) => {
  const el = document.querySelector(`[data-testid="${id}"]`);
  el.value = String(v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}, [id, v]);
const blur = page => page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
const text = async (page, id) => (await tid(page, id).textContent() || "").trim();
const num = async (page, id) => parseFloat(await text(page, id));
const nums = s => (String(s || "").match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);
const polyPoints = async (page, id) => {
  const pts = nums(await tid(page, id).getAttribute("points"));
  const out = [];
  for (let i = 0; i + 1 < pts.length; i += 2) out.push([pts[i], pts[i + 1]]);
  return out;
};
const pixel = (page, x, y) => page.evaluate(([x, y]) => {
  const c = document.querySelector('[data-testid="world"]');
  return Array.from(c.getContext("2d").getImageData(x, y, 1, 1).data.slice(0, 3));
}, [x, y]);
const close = (a, b, rel) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(b));

async function sampleCells(page, W, H) {
  return page.evaluate(([W, H]) => {
    const fox = [], rab = [], grass = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = window.lab.cell(x, y);
      (c.fox ? fox : c.rabbit ? rab : grass).push([x, y, c.grass, !!c.rabbit, !!c.fox]);
    }
    const take = (a, n) => a.filter((_, i) => i % Math.max(1, Math.floor(a.length / n)) === 0).slice(0, n);
    return [...take(fox, 5), ...take(rab, 5), ...take(grass, 5)];
  }, [W, H]);
}
function expectedColour([, , g, rabbit, fox], grassMax) {
  if (fox) return [220, 80, 20];
  if (rabbit) return [240, 240, 240];
  return [30, 60 + Math.round(160 * g / grassMax), 30];
}
async function pixelsMatch(page, W, H, grassMax) {
  const cells = await sampleCells(page, W, H);
  for (const c of cells) {
    const got = await pixel(page, c[0] * 10 + 5, c[1] * 10 + 5), want = expectedColour(c, grassMax);
    if (got.some((v, i) => Math.abs(v - want[i]) > 6)) return { pass: false, detail: `cell ${c[0]},${c[1]}: ${got} vs ${want}` };
  }
  return { pass: cells.length > 0, detail: `${cells.length} cells sampled` };
}

// ---- the catalogue ----
const C = [];
const add = (area, id, run, { clock = false, width, height } = {}) => C.push({ area, id, run, clock, width, height });

// 1. logic
add("logic", "api-present", async ({ page }) => {
  const missing = await page.evaluate(() => ["reset", "step", "counts", "tick", "cell", "history", "ode", "exportCSV",
    "exportScenario", "loadScenario"].filter(m => !window.lab || typeof window.lab[m] !== "function"));
  return { pass: missing.length === 0, detail: missing.length ? `missing ${missing}` : "" };
});
P.cases.forEach((cs, i) => add("logic", `reset-counts-${i}`, async ({ page }) => {
  const a = await page.evaluate(c => window.lab.reset(c.seed, c.params) && window.lab.counts(), cs);
  const b = await R(c => window.lab.reset(c.seed, c.params) && window.lab.counts(), cs);
  return { pass: sameCounts(a, b), detail: `app ${fmt(a)} ref ${fmt(b)}` };
}));
add("logic", "params-apply", async ({ page }) => {
  const r = await page.evaluate(() => { window.lab.reset(5, { rabbits0: 10, foxes0: 0 }); return [window.lab.counts(), window.lab.tick(), window.lab.history().length]; });
  return { pass: r[0].rabbits === 10 && r[0].foxes === 0 && r[1] === 0 && r[2] === 1, detail: fmt(r) };
});
add("logic", "grass-bounds", async ({ page }) => {
  const bad = await page.evaluate(() => {
    window.lab.reset(11, { grassMax: 3 }); window.lab.step(200);
    let n = 0;
    for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) { const g = window.lab.cell(x, y).grass; if (!(g >= 0 && g <= 3)) n++; }
    return n;
  });
  return { pass: bad === 0, detail: `${bad} cells out of [0, 3]` };
});
add("logic", "one-per-cell", async ({ page }) => {
  const r = await page.evaluate(c => {
    window.lab.reset(c.seed, c.params); window.lab.step(300);
    let rab = 0, fox = 0;
    for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) { const k = window.lab.cell(x, y); if (k.rabbit) rab++; if (k.fox) fox++; }
    return [rab, fox, window.lab.counts()];
  }, P.cases[0]);
  return { pass: r[0] === r[2].rabbits && r[1] === r[2].foxes, detail: fmt(r) };
});
add("logic", "energy-positive", async ({ page }) => {
  const bad = await page.evaluate(c => {
    window.lab.reset(c.seed, c.params); window.lab.step(150);
    let n = 0;
    for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) {
      const k = window.lab.cell(x, y);
      if (k.rabbit && !(k.rabbit.energy > 0)) n++;
      if (k.fox && !(k.fox.energy > 0)) n++;
    }
    return n;
  }, P.cases[0]);
  return { pass: bad === 0, detail: `${bad} living animals with energy <= 0` };
});
add("logic", "ids-initial", async ({ page }) => {
  const r = await page.evaluate(() => {
    window.lab.reset(3, { rabbits0: 5, foxes0: 2 });
    const rab = [], fox = [];
    for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) { const k = window.lab.cell(x, y); if (k.rabbit) rab.push(k.rabbit.id); if (k.fox) fox.push(k.fox.id); }
    return [rab.sort((a, b) => a - b), fox.sort((a, b) => a - b)];
  });
  return { pass: fmt(r) === fmt([[1, 2, 3, 4, 5], [6, 7]]), detail: fmt(r) };
});
add("logic", "ui-step", async ({ page }) => {
  await tid(page, "step").click();
  const shown = [await text(page, "tick"), await text(page, "count-rabbits"), await text(page, "count-foxes"), await text(page, "count-grass")];
  const c = await page.evaluate(() => [window.lab.tick(), window.lab.counts()]);
  return { pass: shown[0] === "1" && c[0] === 1 && shown[1] === String(c[1].rabbits) && shown[2] === String(c[1].foxes) && shown[3] === String(c[1].grass), detail: fmt([shown, c]) };
});

// 2. time (fake clock)
const T = { clock: true };
add("time", "play-rate", async ({ page }) => {
  await page.evaluate(() => window.lab.reset(42, {})); await setRange(page, "speed", 10);
  await tid(page, "play").click(); await page.clock.runFor(5000);
  const t = await page.evaluate(() => window.lab.tick()); await tid(page, "pause").click();
  return { pass: t >= 49 && t <= 51, detail: `tick ${t} after 5 s at 10/s` };
}, T);
add("time", "pause-stops", async ({ page }) => {
  await page.evaluate(() => window.lab.reset(42, {})); await setRange(page, "speed", 10);
  await tid(page, "play").click(); await page.clock.runFor(1000); await tid(page, "pause").click();
  const a = await page.evaluate(() => window.lab.tick()); await page.clock.runFor(3000);
  const b = await page.evaluate(() => window.lab.tick());
  return { pass: a > 0 && a === b, detail: `${a} then ${b}` };
}, T);
add("time", "step-one", async ({ page }) => {
  await page.evaluate(() => window.lab.reset(42, {})); await page.clock.runFor(2000);
  const a = await page.evaluate(() => window.lab.tick()); await tid(page, "step").click();
  const b = await page.evaluate(() => window.lab.tick());
  return { pass: a === 0 && b === 1, detail: `${a} -> ${b}` };
}, T);
add("time", "speed-change", async ({ page }) => {
  await page.evaluate(() => window.lab.reset(42, {})); await setRange(page, "speed", 10);
  await tid(page, "play").click(); await page.clock.runFor(1000);
  const a = await page.evaluate(() => window.lab.tick()); await setRange(page, "speed", 20); await page.clock.runFor(2000);
  const b = await page.evaluate(() => window.lab.tick()); await tid(page, "pause").click();
  return { pass: b - a >= 38 && b - a <= 42, detail: `+${b - a} in 2 s at 20/s` };
}, T);
add("time", "speed-slider-dom", async ({ page }) => {
  const r = await page.evaluate(() => { const e = document.querySelector('[data-testid="speed"]'); return [e.type, e.min, e.max, e.value]; });
  return { pass: fmt(r) === fmt(["range", "1", "60", "10"]), detail: fmt(r) };
}, T);
add("time", "space-toggles", async ({ page }) => {
  await page.evaluate(() => window.lab.reset(42, {})); await setRange(page, "speed", 10); await blur(page);
  await page.keyboard.press(" "); await page.clock.runFor(1000);
  await blur(page); await page.keyboard.press(" ");
  const a = await page.evaluate(() => window.lab.tick());
  await page.clock.runFor(1000);
  const b = await page.evaluate(() => window.lab.tick());
  return { pass: a >= 9 && a <= 11 && b === a, detail: `${a} after 1 s playing then Space, ${b} a second later` };
}, T);

// 3. canvas
add("canvas", "canvas-size", async ({ page }) => {
  const r = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="world"]'); const a = [c.width, c.height];
    window.lab.reset(1, { width: 30, height: 20 }); return [a, [c.width, c.height]];
  });
  return { pass: fmt(r) === fmt([[400, 300], [300, 200]]), detail: fmt(r) };
});
add("canvas", "pixels-reset", async ({ page }) => {
  await page.evaluate(c => window.lab.reset(c.seed, c.params), P.cases[0]);
  return pixelsMatch(page, ...dims(P.cases[0].params), P.cases[0].params.grassMax || DEF.grassMax);
});
add("canvas", "pixels-after-step", async ({ page }) => {
  await page.evaluate(c => { window.lab.reset(c.seed, c.params); window.lab.step(10); }, P.cases[1]);
  return pixelsMatch(page, ...dims(P.cases[1].params), P.cases[1].params.grassMax || DEF.grassMax);
});
add("canvas", "pixels-after-reset-ui", async ({ page }) => {
  await page.evaluate(() => window.lab.step(7)); await setField(page, "seed", P.ui_seed); await tid(page, "reset").click();
  return pixelsMatch(page, DEF.width, DEF.height, DEF.grassMax);
});
add("canvas", "fox-over-rabbit", async ({ page }) => {
  const cell = await page.evaluate(() => {
    for (let s = 1; s < 40; s++) {
      window.lab.reset(s, { rabbits0: 300, foxes0: 60 });
      for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) { const k = window.lab.cell(x, y); if (k.rabbit && k.fox) return [x, y]; }
    }
    return null;
  });
  if (!cell) return { pass: false, detail: "no shared cell found" };
  const got = await pixel(page, cell[0] * 10 + 5, cell[1] * 10 + 5);
  return { pass: got.every((v, i) => Math.abs(v - [220, 80, 20][i]) <= 6), detail: `${cell}: ${got}` };
});

// 4. chart
add("chart", "points-equal-history", async ({ page }) => {
  const res = [];
  await page.evaluate(() => window.lab.reset(42, {}));
  for (const n of [0, 50, 70]) {
    if (n) await page.evaluate(n => window.lab.step(n), n);
    const h = await page.evaluate(() => window.lab.history().length);
    res.push([h, (await polyPoints(page, "series-rabbits")).length, (await polyPoints(page, "series-foxes")).length]);
  }
  return { pass: res.every(([h, a, b]) => h === a && h === b) && res[2][0] === 121, detail: fmt(res) };
});
add("chart", "monotone-y", async ({ page }) => {
  await page.evaluate(c => { window.lab.reset(c.seed, c.params); window.lab.step(120); }, P.cases[0]);
  const h = await page.evaluate(() => window.lab.history().map(e => e.rabbits)), pts = await polyPoints(page, "series-rabbits");
  if (pts.length !== h.length) return { pass: false, detail: `${pts.length} points, ${h.length} ticks` };
  for (let i = 0; i < h.length; i++) for (let j = 0; j < h.length; j++)
    if (h[i] > h[j] && !(pts[i][1] < pts[j][1])) return { pass: false, detail: `count ${h[i]} at y ${pts[i][1]} not above ${h[j]} at y ${pts[j][1]}` };
  return { pass: true, detail: "" };
});
add("chart", "monotone-x", async ({ page }) => {
  await page.evaluate(() => { window.lab.reset(42, {}); window.lab.step(60); });
  const pts = await polyPoints(page, "series-foxes");
  return { pass: pts.length === 61 && pts.every((p, i) => i === 0 || p[0] > pts[i - 1][0]), detail: `${pts.length} points` };
});
add("chart", "axes-labelled", async ({ page }) => {
  const t = (await tid(page, "chart").textContent() || "").toLowerCase();
  return { pass: t.includes("tick") && t.includes("count"), detail: t.slice(0, 80) };
});
add("chart", "chart-resets", async ({ page }) => {
  await page.evaluate(() => { window.lab.step(40); window.lab.reset(9, {}); });
  const a = (await polyPoints(page, "series-rabbits")).length, b = (await polyPoints(page, "series-foxes")).length;
  return { pass: a === 1 && b === 1, detail: `${a}, ${b}` };
});

// 5. data
add("data", "csv-exact", async ({ page }) => {
  const r = await page.evaluate(c => {
    window.lab.reset(c.seed, c.params); window.lab.step(40);
    const want = "tick,rabbits,foxes,grass\n" + window.lab.history().map(h => `${h.tick},${h.rabbits},${h.foxes},${h.grass}`).join("\n") + "\n";
    return [window.lab.exportCSV() === want, window.lab.exportCSV().slice(0, 60)];
  }, P.cases[1]);
  return { pass: r[0], detail: r[1] };
});
add("data", "csv-download", async ({ page }) => {
  await page.evaluate(() => { window.lab.reset(42, {}); window.lab.step(15); });
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 5000 }), tid(page, "csv-export").click()]);
  const body = fs.readFileSync(await dl.path(), "utf8"), want = await page.evaluate(() => window.lab.exportCSV());
  return { pass: dl.suggestedFilename() === "ecolab.csv" && body === want, detail: `${dl.suggestedFilename()}, ${body.length} vs ${want.length} chars` };
});
add("data", "scenario-roundtrip", async ({ page }) => {
  const r = await page.evaluate(([c, W, H]) => {
    const dump = () => { const o = []; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) o.push(JSON.stringify(window.lab.cell(x, y))); return o.join(";"); };
    window.lab.reset(c.seed, c.params); const before = dump(); const s = window.lab.exportScenario();
    const o = JSON.parse(s); window.lab.reset(1, {}); const ok = window.lab.loadScenario(s);
    const keys = ["width", "height", "grassMax", "rabbits0", "foxes0", "rabbitStart", "rabbitGain", "rabbitCost", "rabbitBreed", "foxStart", "foxGain", "foxCost", "foxBreed"];
    return [typeof s, o.version, o.seed === c.seed, keys.every(k => k in o.params), Object.entries(c.params).every(([k, v]) => o.params[k] === v), ok, dump() === before];
  }, [P.cases[2], ...dims(P.cases[2].params)]);
  return { pass: fmt(r) === fmt(["string", 1, true, true, true, true, true]), detail: fmt(r) };
});
add("data", "scenario-defaults", async ({ page }) => {
  const r = await page.evaluate(() => {
    const ok = window.lab.loadScenario('{"version":1,"seed":5,"params":{"rabbits0":20}}');
    const a = window.lab.counts(); window.lab.reset(5, { rabbits0: 20 }); const b = window.lab.counts();
    return [ok, a, b];
  });
  return { pass: r[0] === true && sameCounts(r[1], r[2]) && r[1].rabbits === 20, detail: fmt(r) };
});
for (const [id, bad] of [["scenario-bad-json", "{not json"], ["scenario-bad-version", '{"version":2,"seed":1,"params":{}}']]) {
  add("data", id, async ({ page }) => {
    const r = await page.evaluate(bad => {
      window.lab.reset(4, {}); window.lab.step(3);
      const before = JSON.stringify([window.lab.tick(), window.lab.counts(), window.lab.cell(5, 5)]);
      const ok = window.lab.loadScenario(bad);
      return [ok, before === JSON.stringify([window.lab.tick(), window.lab.counts(), window.lab.cell(5, 5)])];
    }, bad);
    const err = tid(page, "scenario-error"), visible = await err.isVisible().catch(() => false), msg = ((await err.textContent().catch(() => "")) || "").trim();
    return { pass: r[0] === false && r[1] && visible && msg.length > 0, detail: fmt([r, visible, msg.slice(0, 60)]) };
  });
}
add("data", "scenario-ui-load", async ({ page }) => {
  await page.evaluate(() => window.lab.step(5));
  await setField(page, "scenario-json", '{"version":1,"seed":12,"params":{"foxes0":3,"rabbits0":44}}');
  await tid(page, "scenario-load").click();
  const r = await page.evaluate(() => { const a = [window.lab.tick(), window.lab.counts()]; window.lab.reset(12, { foxes0: 3, rabbits0: 44 }); return [a, window.lab.counts()]; });
  const msg = ((await tid(page, "scenario-error").textContent()) || "").trim();
  return { pass: r[0][0] === 0 && sameCounts(r[0][1], r[1]) && r[1].foxes === 3 && msg === "", detail: fmt([r, msg]) };
});

// 6. algorithms (against the reference)
P.cases.forEach((cs, i) => {
  add("algo", `state-50-${i}`, async ({ page }) => {
    const wh = dims(cs.params);
    await page.evaluate(c => { window.lab.reset(c.seed, c.params); window.lab.step(50); }, cs);
    await R(c => { window.lab.reset(c.seed, c.params); window.lab.step(50); }, cs);
    const d = firstDiff(await page.evaluate(dumpFn, wh), await R(dumpFn, wh));
    return { pass: d === null, detail: d || "" };
  });
  for (const n of [100, 500]) add("algo", `counts-${n}-${i}`, async ({ page }) => {
    const f = ([c, n]) => { window.lab.reset(c.seed, c.params); window.lab.step(n); return [window.lab.counts(), window.lab.history().length]; };
    const a = await page.evaluate(f, [cs, n]), b = await R(f, [cs, n]);
    return { pass: sameCounts(a[0], b[0]) && a[1] === b[1], detail: `app ${fmt(a)} ref ${fmt(b)}` };
  });
});
add("algo", "breed-ids", async ({ page }) => {
  const f = () => {
    window.lab.reset(8, { rabbits0: 40, foxes0: 3, rabbitBreed: 6 }); window.lab.step(3);
    const ids = [];
    for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) { const k = window.lab.cell(x, y); if (k.rabbit) ids.push(k.rabbit.id); if (k.fox) ids.push(k.fox.id); }
    return ids.sort((a, b) => a - b);
  };
  const a = await page.evaluate(f), b = await R(f);
  return { pass: fmt(a) === fmt(b) && b.includes(44), detail: `app ${a.length} ids up to ${a[a.length - 1]}, ref up to ${b[b.length - 1]}` };
});
add("algo", "extinction-foxes", async ({ page }) => {
  const r = await page.evaluate(() => { window.lab.reset(9, { foxes0: 0 }); window.lab.step(100); return window.lab.history().map(h => h.foxes); });
  return { pass: r.length === 101 && r.every(v => v === 0), detail: `${r.length} points, max ${Math.max(...r)}` };
});
add("algo", "extinction-all", async ({ page }) => {
  const r = await page.evaluate(() => {
    window.lab.reset(9, { rabbitCost: 99, foxCost: 99 }); window.lab.step(1); const a = window.lab.counts();
    window.lab.step(10); return [a, window.lab.counts(), window.lab.history().length];
  });
  return { pass: r[0].rabbits === 0 && r[0].foxes === 0 && r[1].rabbits === 0 && r[2] === 12, detail: fmt(r) };
});

// 7. layout
const box = (page, id) => tid(page, id).boundingBox();
add("layout", "side-by-side-1280", async ({ page }) => {
  const w = await box(page, "panel-world"), s = await box(page, "panel-side");
  return { pass: !!w && !!s && s.x >= w.x + w.width - 2 && Math.abs(s.y - w.y) <= 40, detail: fmt([w, s]) };
}, { width: 1280, height: 900 });
add("layout", "stacked-600", async ({ page }) => {
  const w = await box(page, "panel-world"), s = await box(page, "panel-side");
  return { pass: !!w && !!s && s.y >= w.y + w.height - 2, detail: fmt([w, s]) };
}, { width: 600, height: 900 });
for (const width of [600, 390]) add("layout", `no-hscroll-${width}`, async ({ page }) => {
  const r = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth,
    ["panel-world", "panel-side", "world"].every(id => document.querySelector(`[data-testid="${id}"]`))]);
  return { pass: r[2] && r[0] <= r[1] + 1, detail: fmt(r) };
}, { width, height: 844 });
add("layout", "canvas-fits-390", async ({ page }) => {
  const b = await box(page, "world");
  return { pass: !!b && b.x >= -1 && b.x + b.width <= 391, detail: fmt(b) };
}, { width: 390, height: 844 });

// 8. accessibility
add("a11y", "tab-reaches-controls", async ({ page }) => {
  const want = ["play", "pause", "step", "reset", "speed", "seed", "param-rabbits0", "param-foxes0", "param-rabbitBreed",
    "param-foxBreed", "param-foxGain", "param-grassMax"], seen = new Set();
  await blur(page);
  for (let i = 0; i < 120 && seen.size < want.length; i++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-testid"));
    if (want.includes(id)) seen.add(id);
  }
  const missing = want.filter(w => !seen.has(w));
  return { pass: missing.length === 0, detail: missing.length ? `not reached: ${missing}` : "" };
});
add("a11y", "buttons-keyboard", async ({ page }) => {
  await page.evaluate(() => window.lab.reset(42, {}));
  await tid(page, "step").focus(); await page.keyboard.press("Enter"); await page.keyboard.press(" ");
  const t = await page.evaluate(() => window.lab.tick());
  return { pass: t === 2, detail: `tick ${t} after Enter and Space on step` };
});
add("a11y", "sliders-labelled", async ({ page }) => {
  const bad = await page.evaluate(() => ["speed", "param-rabbits0", "param-foxes0", "param-rabbitBreed", "param-foxBreed", "param-foxGain", "param-grassMax"]
    .filter(id => { const e = document.querySelector(`[data-testid="${id}"]`); return !e || !((e.labels && e.labels.length && e.labels[0].textContent.trim()) || e.getAttribute("aria-label") || e.getAttribute("aria-labelledby")); }));
  return { pass: bad.length === 0, detail: bad.length ? `unlabelled: ${bad}` : "" };
});
add("a11y", "announce-on-pause", async ({ page }) => {
  await page.evaluate(() => window.lab.reset(42, {})); await setRange(page, "speed", 10);
  await tid(page, "play").click(); await page.clock.runFor(1500); await tid(page, "pause").click();
  const c = await page.evaluate(() => [window.lab.tick(), window.lab.counts()]);
  const a = tid(page, "announcer"), t = ((await a.textContent()) || "").trim(), live = await a.getAttribute("aria-live");
  const want = `Tick ${c[0]}: ${c[1].rabbits} rabbits, ${c[1].foxes} foxes`;
  return { pass: t === want && live === "polite", detail: `"${t}" vs "${want}", aria-live ${live}` };
}, T);
add("a11y", "shortcut-s", async ({ page }) => {
  await page.evaluate(() => window.lab.reset(42, {})); await blur(page); await page.keyboard.press("s");
  const t = await page.evaluate(() => window.lab.tick());
  return { pass: t === 1, detail: `tick ${t}` };
});
add("a11y", "shortcut-r", async ({ page }) => {
  await page.evaluate(() => window.lab.step(5)); await setField(page, "seed", 77); await blur(page); await page.keyboard.press("r");
  const r = await page.evaluate(() => { const a = [window.lab.tick(), window.lab.counts()]; window.lab.reset(77, {}); return [a, window.lab.counts()]; });
  return { pass: r[0][0] === 0 && sameCounts(r[0][1], r[1]), detail: fmt(r) };
});
add("a11y", "focus-visible", async ({ page }) => {
  await blur(page);
  for (let i = 0; i < 120; i++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-testid") === "play")) break;
  }
  const s = await page.evaluate(() => { const st = getComputedStyle(document.activeElement); return [document.activeElement.getAttribute("data-testid"), st.outlineStyle, st.outlineWidth, st.boxShadow]; });
  const ring = (s[1] !== "none" && s[2] !== "0px") || (s[3] && s[3] !== "none");
  return { pass: s[0] === "play" && ring, detail: fmt(s) };
});

// 9. persistence
const savePreset = async (page, name) => { await setField(page, "preset-name", name); await tid(page, "preset-save").click(); };
const items = page => page.locator('[data-testid="preset-item"]');
add("persist", "preset-save-reload", async ({ page }) => {
  await page.evaluate(c => window.lab.reset(c.seed, c.params), P.cases[1]); await savePreset(page, "alpha");
  await page.reload({ waitUntil: "load" });
  const names = await items(page).allTextContents();
  const stored = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem("ecolab.presets")); } catch { return null; } });
  return { pass: names.some(n => n.includes("alpha")) && !!stored && stored.alpha && stored.alpha.version === 1 && stored.alpha.seed === P.cases[1].seed, detail: fmt([names, stored && Object.keys(stored)]) };
});
add("persist", "preset-list", async ({ page }) => {
  await savePreset(page, "one"); await savePreset(page, "two");
  const names = await items(page).allTextContents();
  return { pass: names.length === 2 && names.some(n => n.includes("one")) && names.some(n => n.includes("two")), detail: fmt(names) };
});
add("persist", "preset-delete", async ({ page }) => {
  await savePreset(page, "one"); await savePreset(page, "two");
  await items(page).filter({ hasText: "one" }).locator('[data-testid="preset-delete"]').click();
  const names = await items(page).allTextContents();
  const stored = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("ecolab.presets") || "{}")));
  return { pass: names.length === 1 && names[0].includes("two") && fmt(stored) === fmt(["two"]), detail: fmt([names, stored]) };
});
add("persist", "preset-load-applies", async ({ page }) => {
  await page.evaluate(() => window.lab.reset(123, { rabbits0: 33 })); await savePreset(page, "p33");
  await page.evaluate(() => { window.lab.reset(1, {}); window.lab.step(4); });
  await items(page).filter({ hasText: "p33" }).locator('[data-testid="preset-load"]').click();
  const r = await page.evaluate(() => { const a = [window.lab.tick(), window.lab.counts()]; window.lab.reset(123, { rabbits0: 33 }); return [a, window.lab.counts()]; });
  return { pass: r[0][0] === 0 && r[0][1].rabbits === 33 && sameCounts(r[0][1], r[1]), detail: fmt(r) };
});
add("persist", "corrupt-storage", async ({ page, errors }) => {
  await page.evaluate(() => localStorage.setItem("ecolab.presets", "{bad json"));
  errors.length = 0;
  await page.reload({ waitUntil: "load" });
  const n = await items(page).count(), ok = await page.evaluate(() => !!window.lab && typeof window.lab.step === "function");
  return { pass: n === 0 && ok && errors.length === 0, detail: fmt([n, ok, errors.slice(0, 2)]) };
});

// 10. domain
P.ode.forEach((o, i) => add("domain", `ode-values-${i}`, async ({ page }) => {
  const f = o => window.lab.ode(o.p, o.t, o.dt), a = await page.evaluate(f, o), b = await R(f, o);
  return { pass: !!a && close(a.x, b.x, 1e-6) && close(a.y, b.y, 1e-6), detail: `app ${fmt(a)} ref ${fmt(b)}` };
}));
add("domain", "ode-steps-rounding", async ({ page }) => {
  const o = { p: { alpha: 1.1, beta: 0.4, gamma: 0.4, delta: 0.1, x0: 10, y0: 10 }, t: 0.105, dt: 0.01 };
  const f = o => window.lab.ode(o.p, o.t, o.dt), a = await page.evaluate(f, o), b = await R(f, o);
  return { pass: !!a && close(a.x, b.x, 1e-9) && close(a.y, b.y, 1e-9), detail: `app ${fmt(a)} ref ${fmt(b)}` };
});
const odeInputs = { "ode-alpha": 0.8, "ode-beta": 0.2, "ode-gamma": 0.9, "ode-delta": 0.15, "ode-x0": 5, "ode-y0": 3, "ode-t": 30, "ode-dt": 0.02 };
const runOde = async (page, inputs) => { for (const [k, v] of Object.entries(inputs)) await setField(page, k, v); await tid(page, "ode-run").click(); };
add("domain", "eq-dom", async ({ page }) => {
  await runOde(page, odeInputs);
  const x = await num(page, "ode-eq-x"), y = await num(page, "ode-eq-y");
  return { pass: close(x, 6, 1e-6) && close(y, 4, 1e-6), detail: `${x}, ${y}` };
});
add("domain", "drift-small", async ({ page }) => {
  await runOde(page, { "ode-alpha": 1.1, "ode-beta": 0.4, "ode-gamma": 0.4, "ode-delta": 0.1, "ode-x0": 10, "ode-y0": 10, "ode-t": 50, "ode-dt": 0.01 });
  const d = await num(page, "ode-drift");
  return { pass: Number.isFinite(d) && d >= 0 && d < 1e-4, detail: String(d) };
});
add("domain", "ode-ui-run", async ({ page }) => {
  await runOde(page, odeInputs);
  const x = await num(page, "ode-x"), y = await num(page, "ode-y");
  const want = await R(() => window.lab.ode({ alpha: 0.8, beta: 0.2, gamma: 0.9, delta: 0.15, x0: 5, y0: 3 }, 30, 0.02));
  return { pass: close(x, want.x, 1e-7) && close(y, want.y, 1e-7), detail: `${x}, ${y} vs ${fmt(want)}` };
});
add("domain", "ode-chart", async ({ page }) => {
  await runOde(page, odeInputs);
  const a = (await polyPoints(page, "ode-series-x")).length, b = (await polyPoints(page, "ode-series-y")).length;
  return { pass: a >= 2 && b >= 2, detail: `${a}, ${b} points` };
});

// ---- runner ----
async function runOne(c) {
  const env = await open("app.html", { width: c.width || 1280, height: c.height || 900, clock: c.clock });
  try {
    const res = await Promise.race([c.run(env), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), TIMEOUT))]);
    return { id: c.id, area: c.area, pass: !!res.pass, detail: String(res.detail || "").slice(0, 300) };
  } catch (e) {
    return { id: c.id, area: c.area, pass: false, detail: `error: ${String(e.message || e).split("\n")[0].slice(0, 280)}` };
  } finally {
    await env.ctx.close().catch(() => {});
  }
}

const only = args.only ? String(args.only).split(",") : null;
const results = [];
for (const c of C) if (!only || only.includes(c.id)) results.push(await runOne(c));

const load = await open("app.html");
await load.page.waitForTimeout(500);
const consoleErrors = load.errors.slice();
if (args.shots) {
  fs.mkdirSync(args.shots, { recursive: true });
  const shot = async (name, fn, vp) => {
    const e = vp ? await open("app.html", vp) : await open("app.html");
    try { if (fn) await fn(e.page); await e.page.screenshot({ path: path.join(args.shots, name), fullPage: true }); }
    catch (err) { fs.writeFileSync(path.join(args.shots, name + ".error.txt"), String(err)); }
    finally { await e.ctx.close(); }
  };
  await shot("load.png");
  await shot("step200.png", p => p.evaluate(() => window.lab.step(200)));
  await shot("phone.png", null, { width: 390, height: 844 });
  await shot("ode.png", p => p.locator('[data-testid="ode-run"]').first().click());
}
await load.ctx.close();

const areas = {};
for (const r of results) (areas[r.area] ||= []).push(r.pass ? 1 : 0);
const areaScore = Object.fromEntries(Object.entries(areas).map(([a, v]) => [a, v.reduce((s, x) => s + x, 0) / v.length]));
const score = Object.values(areaScore).reduce((s, x) => s + x, 0) / Math.max(1, Object.keys(areaScore).length);
const out = { score, areas: areaScore, passed: results.filter(r => r.pass).length, total: results.length,
  console_errors: consoleErrors, blocked_requests: blocked, checks: results };
fs.writeFileSync(args.out, JSON.stringify(out, null, 1));
console.log(`score ${score.toFixed(3)} (${out.passed}/${out.total}); ` + Object.entries(areaScore).map(([a, v]) => `${a} ${v.toFixed(2)}`).join(", ") +
  `; console errors ${consoleErrors.length}; blocked ${blocked}`);
await ref.ctx.close();
await browser.close();
server.close();
