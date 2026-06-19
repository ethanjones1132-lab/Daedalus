import { executeTool } from "./tools";
import { loadConfig } from "./config";

const cfg = loadConfig();

console.log("--- TESTING DIAGNOSE SYSTEM ---");
const diagResult = await executeTool({
  id: "test_diag",
  name: "diagnose_system",
  arguments: {}
}, cfg);
console.log("Status:", diagResult.is_error ? "ERROR" : "SUCCESS");
console.log(diagResult.output);

console.log("\n--- TESTING SQLITE QUERY ---");
const sqlResult = await executeTool({
  id: "test_sql",
  name: "query_sqlite",
  arguments: { query: "SELECT key, value FROM settings LIMIT 5;" }
}, cfg);
console.log("Status:", sqlResult.is_error ? "ERROR" : "SUCCESS");
console.log(sqlResult.output);

console.log("\n--- TESTING PRIZEPICKS MATCHUPS ---");
const matchResult = await executeTool({
  id: "test_matchups",
  name: "fetch_prizepicks_matchups",
  arguments: { position: "QB" }
}, cfg);
console.log("Status:", matchResult.is_error ? "ERROR" : "SUCCESS");
console.log(matchResult.output);
