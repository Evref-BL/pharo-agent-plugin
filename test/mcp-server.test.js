import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = path.join(root, "bin/pharo-agent.js");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function temporaryProject() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-mcp-"));
  fs.writeFileSync(path.join(directory, "plexus.json"), `${JSON.stringify({ images: [] })}\n`);
  return directory;
}

// Drives the server over stdio the way a host does, and answers with what it
// listed. Nothing here opens an image: that is the point of these tests.
function listTools({ cwd, env = {} }) {
  const request = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "test", version: "1" },
    } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ].map((message) => JSON.stringify(message)).join("\n");

  const served = spawnSync(process.execPath, [binary, "mcp"], {
    cwd,
    input: `${request}\n`,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, ...env },
  });

  const answers = served.stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  return {
    served,
    initialize: answers.find((answer) => answer.id === 1)?.result,
    tools: answers.find((answer) => answer.id === 2)?.result?.tools,
  };
}

test("the plugin declares the server a host starts", () => {
  const declared = readJson(".mcp.json").mcpServers;
  const packageJson = readJson("package.json");

  assert.deepEqual(
    declared.image.args,
    ["${CLAUDE_PLUGIN_ROOT}/bin/pharo-agent.js", "mcp"],
    "the server has to be started from the plugin's own directory, whatever it is",
  );
  assert.equal(declared.image.args[0].endsWith(packageJson.bin["pharo-agent"].slice(1)), true);
  assert.equal(
    packageJson.files.includes(".mcp.json"),
    true,
    "a declaration npm does not ship is a plugin with no server",
  );
});

test("the server starts and lists its lifecycle tools with no image open", () => {
  const cwd = temporaryProject();
  try {
    const { served, initialize, tools } = listTools({ cwd });

    assert.equal(served.status, 0, served.stderr);
    assert.equal(initialize.capabilities.tools.listChanged, true);
    assert.match(initialize.instructions, /Pharo/);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["pharo_open", "pharo_status", "pharo_close"],
      "a host starts this before anyone opens an image, so the list must not be empty",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("the host says where the project is when the working directory does not", () => {
  const project = temporaryProject();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-elsewhere-"));
  try {
    const { served, tools } = listTools({
      cwd: elsewhere,
      env: { CLAUDE_PROJECT_DIR: project },
    });

    assert.equal(served.status, 0, served.stderr);
    assert.equal(tools.length, 3, "a plugin runs from its own directory, not the project's");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("a directory with no project still gets a server rather than a dead one", () => {
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-noproject-"));
  try {
    const { served, tools } = listTools({ cwd: elsewhere, env: { CLAUDE_PROJECT_DIR: elsewhere } });

    assert.equal(served.status, 0, "a server that exits is a broken server in the host's list");
    assert.deepEqual(tools.map((tool) => tool.name), ["pharo_open", "pharo_status", "pharo_close"]);
  } finally {
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});
