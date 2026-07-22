// Baseline helper. Credentials are supplied through the live Jarvis config by
// default, or through JARVIS_BENCHMARK_BASE_URL/JARVIS_BENCHMARK_API_KEY.
import { readFileSync, writeFileSync } from "fs";

const [, , promptFile, outFile] = process.argv;
const configPath = process.env.JARVIS_CONFIG_PATH || "C:/Users/ethan/.openclaw/jarvis/config.json";
const config = JSON.parse(readFileSync(configPath, "utf-8"));
const endpoint = (process.env.JARVIS_BENCHMARK_BASE_URL || config.opencode_zen?.base_url || "https://opencode.ai/zen/v1").replace(/\/+$/, "");
const apiKey = process.env.JARVIS_BENCHMARK_API_KEY || config.opencode_zen?.api_key;
if (!apiKey) throw new Error("missing benchmark API key");
const prompt = readFileSync(promptFile, "utf-8");
const started = Date.now();
let content = "";
let error = null;
try {
  const response = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.JARVIS_BENCHMARK_MODEL || "deepseek-v4-flash-free", messages: [{ role: "user", content: prompt }], temperature: 0.2, max_tokens: 3000 }),
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) error = `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`;
  else content = (await response.json()).choices?.[0]?.message?.content ?? "";
} catch (cause) { error = String(cause).slice(0, 300); }
writeFileSync(outFile, JSON.stringify({ content, error, secs: (Date.now() - started) / 1000 }), "utf-8");
