// Runs a teacher seed's web acceptance test: node run_web_test.mjs path/to/index.html path/to/test_acceptance.mjs
// The test module's default export is `async function (page)`; it throws on failure. Exit 0 = pass.
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../oneshot/package.json", import.meta.url));
const { chromium } = require("playwright");
const [file, testFile] = process.argv.slice(2);
const html = fs.readFileSync(file);
const server = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(html); });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "chrome", headless: true });
let code = 0;
try {
  const test = (await import(pathToFileURL(testFile).href)).default;
  const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await test(page);
  if (errors.length) { console.error("page errors:", errors.slice(0, 3).join(" | ")); code = 1; }
  else console.log("PASS");
} catch (e) {
  console.error(String(e && e.stack || e).slice(0, 1200));
  code = 1;
}
await browser.close();
server.close();
process.exit(code);
