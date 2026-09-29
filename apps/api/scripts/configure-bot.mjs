// Wire only local persistence settings; preserve every provider key.
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { parseEnv } from "node:util";
const varsPath = new URL("../.dev.vars", import.meta.url);
let vars = await readFile(varsPath, "utf8");
const token = parseEnv(vars).CALLS_INGEST_TOKEN;
if (!token) throw new Error("Set CALLS_INGEST_TOKEN in apps/api/.dev.vars first.");
let host = "127.0.0.1";
if (process.platform === "win32") {
  const route = execFileSync("wsl", ["-d", "Ubuntu", "--", "ip", "-4", "route", "show", "default"], { encoding: "utf8" });
  const match = /default via (\d+\.\d+\.\d+\.\d+)/.exec(route);
  if (!match) throw new Error("Could not identify the Windows WSL adapter.");
  host = match[1];
}
const base = "http://" + host + ":8787";
function setLine(contents, name, value) {
  const pattern = new RegExp("^" + name + "=.*$", "m");
  return pattern.test(contents) ? contents.replace(pattern, () => name + "=" + value)
    : contents.trimEnd() + "\n" + name + "=" + value + "\n";
}
const botPath = new URL("../../../bot/.env", import.meta.url);
let bot = await readFile(botPath, "utf8");
bot = setLine(bot, "CALLS_API_BASE_URL", base);
bot = setLine(bot, "CALLS_INGEST_TOKEN", token);
await writeFile(botPath, bot);
vars = setLine(vars, "LOCAL_API_BASE_URL", base);
await writeFile(varsPath, vars);
const webPath = new URL("../../web/.env", import.meta.url);
let web = await readFile(webPath, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
await writeFile(webPath, setLine(web, "VITE_API_BASE_URL", base));
console.log("Local upload URL configured: " + base);
console.log("Ingestion credentials synchronized without displaying them. Restart Worker, bot, and frontend.");
