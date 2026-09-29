// Bind to the configured local adapter; do not expose the Worker on all LAN interfaces.
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
let env = {};
try { env = parseEnv(await readFile(new URL("../.dev.vars", import.meta.url), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const base = new URL(env.LOCAL_API_BASE_URL || "http://127.0.0.1:8787");
if (base.protocol !== "http:" || base.port !== "8787") throw new Error("Expected a local HTTP development URL on port 8787.");
const cli = new URL("../../../node_modules/wrangler/bin/wrangler.js", import.meta.url);
const child = spawn(process.execPath, [cli.pathname.replace(/^\/(\w:)/, "$1"),
  "dev", "--ip", base.hostname, "--port", "8787"], { stdio: "inherit", shell: false });
child.on("exit", code => { process.exitCode = code ?? 1; });
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
