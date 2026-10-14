// Acceptance checks for the teacher comparison's two web builds (compare_tasks.py). Usage:
// node check_web.mjs path/to/index.html web_pomodoro|web_draw  -> prints one JSON object {check: passed}
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const require = createRequire(new URL("../oneshot/package.json", import.meta.url));
const { chromium } = require("playwright");
const [file, task] = process.argv.slice(2);
const html = fs.readFileSync(file);
const server = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(html); });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const out = {};
const errors = [];
const ok = async (name, fn) => { try { out[name] = Boolean(await fn()); } catch { out[name] = false; } };

async function newPage(clock) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(4000);
  page.on("pageerror", e => errors.push(String(e)));
  if (clock) await page.clock.install({ time: new Date("2026-10-08T12:00:00Z") });
  await page.goto(url);
  return page;
}
const setValue = (page, sel, v) => page.$eval(sel, (el, v) => {
  el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
}, v);
const secs = t => { const m = /^(\d+):(\d\d)$/.exec(t.trim()); return m ? +m[1] * 60 + +m[2] : NaN; };

if (task === "web_pomodoro") {
  const page = await newPage(true);
  const ids = ["#work-minutes", "#break-minutes", "#time", "#start", "#reset", "#task-input", "#add-task", "#task-list"];
  await ok("elements", async () => (await Promise.all(ids.map(s => page.$(s)))).every(Boolean));
  await ok("default_25", async () => (await page.textContent("#time")).trim() === "25:00");
  await ok("set_minutes", async () => { await setValue(page, "#work-minutes", "1"); return (await page.textContent("#time")).trim() === "01:00"; });
  await ok("add_task", async () => {
    await page.fill("#task-input", "Write report"); await page.click("#add-task");
    return (await page.$$eval("#task-list li", ls => ls.map(l => l.textContent))).some(t => t.includes("Write report"));
  });
  await ok("countdown", async () => {
    await page.click("#task-list li"); await page.click("#start"); await page.clock.runFor(3000);
    const s = secs(await page.textContent("#time")); return s < 60 && s >= 55;
  });
  await ok("work_to_break", async () => {
    const before = await page.textContent("#task-list li");
    await page.clock.runFor(60000);
    const s = secs(await page.textContent("#time"));
    const after = await page.textContent("#task-list li");
    out.pomodoro_counted = after !== before && /1/.test(after);
    return s > 0 && s <= 300;
  });
  await ok("persist", async () => {
    await page.reload();
    const tasks = await page.$$eval("#task-list li", ls => ls.map(l => l.textContent));
    return tasks.some(t => t.includes("Write report")) && (await page.inputValue("#work-minutes")) === "1";
  });
  await ok("reset", async () => { await page.click("#reset"); return (await page.textContent("#time")).trim() === "01:00"; });
} else {
  const page = await newPage(false);
  const ids = ["#canvas", "#color", "#size", "#undo", "#redo", "#clear", "#export"];
  await ok("elements", async () => (await Promise.all(ids.map(s => page.$(s)))).every(Boolean));
  await ok("size_600x400", () => page.$eval("#canvas", c => c.width === 600 && c.height === 400));
  const ink = () => page.$eval("#canvas", c => {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0, red = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 0 && (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245)) n++;
      if (d[i + 3] > 0 && d[i] > 200 && d[i + 1] < 70 && d[i + 2] < 70) red++;
    }
    return { n, red };
  });
  const stroke = async (x0, y0, x1, y1) => {
    const b = await (await page.$("#canvas")).boundingBox();
    await page.mouse.move(b.x + x0, b.y + y0); await page.mouse.down();
    for (let k = 1; k <= 10; k++) await page.mouse.move(b.x + x0 + (x1 - x0) * k / 10, b.y + y0 + (y1 - y0) * k / 10);
    await page.mouse.up();
  };
  await ok("draws", async () => { await setValue(page, "#size", "10"); await stroke(100, 100, 300, 200); return (await ink()).n > 100; });
  await ok("undo", async () => { await page.click("#undo"); return (await ink()).n === 0; });
  await ok("redo", async () => { await page.click("#redo"); return (await ink()).n > 100; });
  await ok("color", async () => { await setValue(page, "#color", "#ff0000"); await stroke(100, 300, 400, 300); return (await ink()).red > 50; });
  await ok("clear_undoable", async () => {
    await page.click("#clear"); const blank = (await ink()).n === 0;
    await page.click("#undo"); return blank && (await ink()).n > 100;
  });
  await ok("export_png", async () => {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#export")]);
    return dl.suggestedFilename() === "drawing.png";
  });
}
out.no_page_errors = errors.length === 0;
await browser.close();
server.close();
console.log(JSON.stringify(out));
