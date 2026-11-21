import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The server `.mcp.json` declares, started as a host starts it: the plugin's
 * variables expanded, in a home of its own, away from the settings file a
 * user's telemetry lives in.
 */
function startDeclaredServer(project, home) {
  const declared = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8")).mcpServers.pharo;
  const expand = (text) =>
    text.replaceAll("${CLAUDE_PLUGIN_ROOT}", root).replaceAll("${CLAUDE_PROJECT_DIR}", project);
  const command = declared.command === "node" ? process.execPath : declared.command;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OTEL_") && !name.startsWith("PLEXUS_")));
  return spawn(command, declared.args.map(expand), {
    env: { ...environment, PLEXUS_HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, APPDATA: home, LOCALAPPDATA: home },
    stdio: ["pipe", "pipe", "inherit"],
  });
}

test("the declared server serves the image tools and the instructions, in the project's scope", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-server-"));
  const project = path.join(scratch, "My Project");
  const home = path.join(scratch, "home");
  fs.mkdirSync(project);
  // An image of this project's scope and one of another's.
  for (const disk of ["My_Project-dev", "Other-dev"]) {
    fs.mkdirSync(path.join(home, "profiles", "images", disk), { recursive: true });
    fs.writeFileSync(path.join(home, "profiles", "images", disk, `${disk}.image`), "");
  }
  const server = startDeclaredServer(project, home);
  try {
    const answers = createInterface({ input: server.stdout });
    const pending = new Map();
    answers.on("line", (line) => {
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
    });
    let next = 0;
    // A server that exits or never answers fails the test rather than hangs it.
    const ended = new Promise((_resolve, reject) => {
      server.on("exit", (code) => reject(new Error(`the server exited with ${code}`)));
    });
    const ask = (method, params) =>
      Promise.race([
        new Promise((resolve) => {
          const id = ++next;
          pending.set(id, resolve);
          server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        }),
        ended,
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`no answer to ${method}`)), 20_000).unref()),
      ]);

    const initialized = await ask("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "plugin-test", version: "1.0.0" },
    });
    assert.equal(initialized.result.serverInfo.name, "plexus");
    assert.match(initialized.result.instructions, /Search these tools for any Pharo, Smalltalk, Tonel or \.st work\./);
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const listed = await ask("tools/list", {});
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      ["image_templates", "image_create", "image_start", "image_stop", "image_delete", "image_list"],
    );

    const images = await ask("tools/call", { name: "image_list", arguments: {} });
    assert.equal(images.result.isError, undefined);
    assert.match(images.result.content[0].text, /^1 image, none running\.\nimages:\n {2}dev state=stopped$/);
  } finally {
    server.removeAllListeners("exit");
    server.kill();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
