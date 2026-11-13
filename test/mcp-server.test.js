import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readConfig, writeConfig } from "../src/project.js";
import {
  callsOf,
  pinnedImage,
  plexusHook,
  readWorld,
  runningImage,
  useFakePlexus,
} from "./support/fake-plexus.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = path.join(root, "bin/pharo-agent.js");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

/**
 * A project and a fake PLexus store the server processes share, dropped
 * afterwards.
 *
 * @param {(cwd: string) => void} run
 * @param {Parameters<typeof useFakePlexus>[0]} [world]
 * @param {Record<string, unknown>} [config]
 */
function inProject(run, world = {}, config = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-mcp-"));
  const dropStore = useFakePlexus(world);
  try {
    writeConfig(cwd, { scope: "proj", ...config });
    run(cwd);
  } finally {
    dropStore();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const projectToolNames = [
  "image_templates",
  "image_create",
  "image_list",
  "image_start",
  "image_stop",
  "image_delete",
];

/**
 * Drives the server over stdio the way a host does, one request after the
 * handshake, and answers with everything it wrote.
 *
 * @param {{ cwd: string, request: Record<string, unknown>, env?: Record<string, string> }} options
 */
function serve({ cwd, request, env = {} }) {
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "test", version: "1" },
    } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, ...request },
  ].map((message) => JSON.stringify(message)).join("\n");

  // The host running these tests may name its own project, which is not
  // the one a test means.
  const { CLAUDE_PROJECT_DIR: _host, ...inherited } = process.env;
  const served = spawnSync(process.execPath, ["--import", plexusHook, binary, "mcp"], {
    cwd,
    input: `${input}\n`,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...inherited, PHARO_AGENT_PROJECTION: "off", ...env },
  });
  const messages = served.stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  const answer = messages.find((message) => message.id === 2);
  return {
    served,
    messages,
    initialize: messages.find((message) => message.id === 1)?.result,
    result: answer?.result,
    error: answer?.error,
  };
}

function listTools(cwd, env = {}) {
  const answer = serve({ cwd, request: { method: "tools/list" }, env });
  return { ...answer, tools: answer.result?.tools };
}

function callTool(cwd, name, toolArguments = {}) {
  return serve({ cwd, request: { method: "tools/call", params: { name, arguments: toolArguments } } });
}

function answerOf(result) {
  return JSON.parse(result.content[0].text);
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

test("the server starts and lists its image tools with no image running", () => {
  inProject((cwd) => {
    const { served, initialize, tools } = listTools(cwd);

    assert.equal(served.status, 0, served.stderr);
    assert.equal(initialize.capabilities.tools.listChanged, true);
    assert.match(initialize.instructions, /Pharo/);
    assert.doesNotMatch(initialize.instructions, /image_add/);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      projectToolNames,
      "a host starts this before anyone starts an image, so the list must not be empty",
    );
  });
});

test("the host says where the project is when the working directory does not", () => {
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-elsewhere-"));
  try {
    inProject((project) => {
      const { served, tools } = listTools(elsewhere, { CLAUDE_PROJECT_DIR: project });

      assert.equal(served.status, 0, served.stderr);
      assert.ok(tools.some((tool) => tool.name === "class_get"), "a plugin runs from its own directory, not the project's");
    }, {
      images: { "proj-dev": runningImage(41000, { tools: [{ name: "class_get", inputSchema: { type: "object" } }] }) },
    }, { defaultImage: "dev" });
  } finally {
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("a directory with no project still gets a server rather than a dead one", () => {
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-noproject-"));
  try {
    const { served, tools } = listTools(elsewhere, { CLAUDE_PROJECT_DIR: elsewhere });

    assert.equal(served.status, 0, "a server that exits is a broken server in the host's list");
    assert.deepEqual(tools.map((tool) => tool.name), projectToolNames);
  } finally {
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("the default image's tools follow the server's own, each taking an image", () => {
  inProject((cwd) => {
    const { served, tools } = listTools(cwd);

    assert.equal(served.status, 0, served.stderr);
    assert.deepEqual(tools.map((tool) => tool.name), [...projectToolNames, "class_get"]);
    assert.match(tools.at(-1).inputSchema.properties.image.description, /Defaults to dev/);
    assert.deepEqual(
      callsOf("listTools").map((call) => call.url),
      ["http://127.0.0.1:41000/"],
      "only the selected image is asked",
    );
  }, {
    images: {
      "proj-dev": runningImage(41000, { tools: [{ name: "class_get", inputSchema: { type: "object", properties: {} } }] }),
      "proj-ci": runningImage(42000, { tools: [{ name: "test_run", inputSchema: { type: "object" } }] }),
    },
  }, { defaultImage: "dev" });
});

test("an image that does not answer leaves the image tools listed", () => {
  // Failing the whole list took image_stop with it, so an agent whose image
  // hung could neither see what was wrong nor stop it.
  inProject((cwd) => {
    const { served, tools } = listTools(cwd);

    assert.equal(served.status, 0, served.stderr);
    assert.deepEqual(tools?.map((tool) => tool.name), projectToolNames, served.stdout);
    assert.match(served.stderr, /image dev listed no tools/);
  }, { images: { "proj-dev": runningImage(41000, { unreachable: true }) } }, { defaultImage: "dev" });
});

test("an image is created through the server, and becomes the default", () => {
  inProject((cwd) => {
    const { served, result } = callTool(cwd, "image_create", {
      name: "dev",
      template: "Pharo 14.0 - 64bit (stable)",
    });

    assert.equal(served.status, 0, served.stderr);
    assert.equal(result.isError, undefined, served.stdout);
    const created = answerOf(result);
    assert.equal(created.ok, true);
    assert.equal(created.name, "dev");
    assert.equal(created.isDefault, true);
    assert.equal(readConfig(cwd).defaultImage, "dev");

    const listed = answerOf(callTool(cwd, "image_list").result);
    assert.equal(listed.defaultImage, "dev");
    assert.deepEqual(listed.images.map((image) => [image.name, image.running]), [["dev", false]]);
  });
});

test("a create with no template is refused where the caller can read it", () => {
  // The input schema is a description. Nothing between a model and this
  // server enforces it, so the missing field is named here.
  inProject((cwd) => {
    const { result, error } = callTool(cwd, "image_create", { name: "dev" });

    assert.equal(result, undefined);
    assert.match(error.message, /image_create needs template/);
    assert.deepEqual(callsOf("create"), [], "a refused create never reaches PLexus");
  });
});

test("a start through the server says the tool list changed", () => {
  inProject((cwd) => {
    const { served, result, messages } = callTool(cwd, "image_start", {});

    assert.equal(served.status, 0, served.stderr);
    assert.equal(answerOf(result).name, "dev");
    assert.ok(messages.some((message) => message.method === "notifications/tools/list_changed"));
    assert.notEqual(readWorld().images["proj-dev"].running, undefined);
  }, { images: { "proj-dev": pinnedImage() } }, { defaultImage: "dev" });
});

test("an image tool goes to the image its argument names, without that argument", () => {
  inProject((cwd) => {
    const { served, result } = callTool(cwd, "class_get", { image: "ci", name: "Point" });

    assert.equal(served.status, 0, served.stderr);
    assert.deepEqual(result.content, [{ type: "text", text: "Point" }]);
    assert.deepEqual(callsOf("callTool"), [
      { op: "callTool", url: "http://127.0.0.1:42000/", tool: "class_get", arguments: { name: "Point" } },
    ]);
  }, {
    images: {
      "proj-dev": runningImage(41000),
      "proj-ci": runningImage(42000, { answers: [{ tool: "class_get", result: { content: [{ type: "text", text: "Point" }] } }] }),
    },
  }, { defaultImage: "dev" });
});

test("a delete through the server needs the name, never the default", () => {
  inProject((cwd) => {
    const { error } = callTool(cwd, "image_delete", {});

    assert.match(error.message, /image_delete needs name/);
    assert.deepEqual(callsOf("delete"), []);
    assert.ok(readWorld().images["proj-dev"]);
  }, { images: { "proj-dev": pinnedImage() } }, { defaultImage: "dev" });
});

// Dropping the name read the pair as its most destructive half: every
// running image of the project, other sessions' included.
test("a stop through the server that names an image and asks for all is refused", () => {
  inProject((cwd) => {
    const { error } = callTool(cwd, "image_stop", { name: "dev", all: true });

    assert.match(error.message, /takes no image name/);
    assert.deepEqual(callsOf("stop"), []);
    assert.notEqual(readWorld().images["proj-ci"].running, undefined);
  }, { images: { "proj-dev": runningImage(41000), "proj-ci": runningImage(42000) } });
});
