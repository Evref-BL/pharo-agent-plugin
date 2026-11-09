import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { addImage } from "../src/images.js";
import { createProjectConfig } from "../src/project.js";
import { writeRunningImages } from "../src/runtime.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = path.join(root, "bin/pharo-agent.js");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function temporaryProject() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-mcp-"));
  createProjectConfig(directory);
  return directory;
}

const projectToolNames = [
  "image_templates",
  "image_add",
  "image_start",
  "image_list",
  "image_stop",
];

// One call, answered the way a host would get it. Nothing here starts an
// image: declaring one does not, which is the point of these tests.
function callTool({ cwd, name, toolArguments = {} }) {
  const request = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "test", version: "1" },
    } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: toolArguments } },
  ].map((message) => JSON.stringify(message)).join("\n");

  const served = spawnSync(process.execPath, [binary, "mcp"], {
    cwd,
    input: `${request}\n`,
    encoding: "utf8",
    timeout: 20_000,
  });
  const answer = served.stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))
    .find((message) => message.id === 2);
  return { served, result: answer?.result, error: answer?.error };
}

function answerOf(result) {
  return JSON.parse(result.content[0].text);
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

  assert.equal(
    Object.keys(declared).join(),
    "pharo",
    "the connector carries the name a user reads in the host, and that name is the language",
  );
  assert.deepEqual(
    declared.pharo.args,
    ["${CLAUDE_PLUGIN_ROOT}/bin/pharo-agent.js", "mcp"],
    "the server has to be started from the plugin's own directory, whatever it is",
  );
  assert.equal(declared.pharo.args[0].endsWith(packageJson.bin["pharo-agent"].slice(1)), true);
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
      projectToolNames,
      "a host starts this before anyone starts an image, so the list must not be empty",
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
    assert.equal(
      tools.length,
      projectToolNames.length,
      "a plugin runs from its own directory, not the project's",
    );
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
    assert.deepEqual(tools.map((tool) => tool.name), projectToolNames);
  } finally {
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

// The project's record of a started image, and what PLexus keeps for it: its
// state, saying it runs as `pid`, and the endpoint the image handed over, on a
// port nothing listens on.
function recordUnansweringImage(cwd, pid) {
  const statePath = path.join(cwd, "state.json");
  const endpoint = { transport: "http", host: "127.0.0.1", port: 1, path: "/", pid };
  fs.writeFileSync(statePath, `${JSON.stringify({
    projectId: "project",
    projectName: "project",
    workspaceId: "workspace",
    images: [{ id: "dev", status: "running", pid, mcpServers: [{ id: "dev", endpoint }] }],
  })}\n`);
  fs.mkdirSync(path.join(cwd, "mcp-endpoints"));
  fs.writeFileSync(
    path.join(cwd, "mcp-endpoints", "dev.properties"),
    Object.entries(endpoint).map(([key, value]) => `${key}=${value}`).join("\n"),
  );
  writeRunningImages(cwd, { dev: { statePath, imageId: "dev", mcpServerId: "dev" } });
}

test("an image that does not answer leaves the lifecycle tools listed", () => {
  // Failing the whole list took image_start with it, so an agent whose image
  // had crashed could neither see what was wrong nor start it again. PLexus
  // skips an image whose process is gone, so a lone crashed image listed
  // nothing quietly; it failed beside another running image, whose schema
  // was not the one asked for. Any image it does ask and gets no answer from
  // fails the same way, and this one is still running, on a port nobody
  // listens on.
  const cwd = temporaryProject();
  try {
    addImage(cwd, { id: "dev", template: "Pharo 14.0 - 64bit (next stable)" });
    recordUnansweringImage(cwd, process.pid);

    const { served, tools } = listTools({ cwd });

    assert.equal(served.status, 0, served.stderr);
    assert.deepEqual(tools?.map((tool) => tool.name), projectToolNames, served.stdout);
    assert.match(served.stderr, /image dev listed no tools/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("an image is declared through the server, with no shell", () => {
  // Declaring was the one step of the lifecycle that a chat could not take:
  // the tools started, listed and stopped images a CLI had to register first.
  const cwd = temporaryProject();
  try {
    const { served, result } = callTool({
      cwd,
      name: "image_add",
      toolArguments: { id: "dev", template: "Pharo 14.0 - 64bit (next stable)" },
    });

    assert.equal(served.status, 0, served.stderr);
    assert.equal(result.isError, undefined, served.stdout);
    // The name is PLexus's default template, whose exact form is PLexus's.
    const { imageName, ...answer } = answerOf(result);
    assert.match(imageName, /\{workspaceId\}-dev$/);
    assert.deepEqual(answer, {
      ok: true,
      id: "dev",
      isDefault: true,
      templateName: "Pharo 14.0 - 64bit (next stable)",
    });

    const listed = answerOf(callTool({ cwd, name: "image_list" }).result);
    assert.equal(listed.defaultImage, "dev");
    assert.deepEqual(listed.images.map((image) => image.running), [false]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a declaration with no template is refused where the caller can read it", () => {
  // The input schema is a description. Nothing between a model and this
  // server enforces it, so the missing field is named here.
  const cwd = temporaryProject();
  try {
    const { result, error } = callTool({ cwd, name: "image_add", toolArguments: { id: "dev" } });

    assert.equal(result, undefined);
    assert.match(error.message, /needs a template name/);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(cwd, "plexus.json"), "utf8")).images.length,
      0,
      "a refused declaration leaves the project as it was",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
