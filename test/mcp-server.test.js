import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listingTimeoutMs } from "../src/mcpServer.js";
import { readConfig, writeConfig } from "../src/project.js";
import {
  callsOf,
  changeImages,
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
 * afterwards, once the promise `run` answers settles when it answers one.
 *
 * @template T
 * @param {(cwd: string) => T} run
 * @param {Parameters<typeof useFakePlexus>[0]} [world]
 * @param {Record<string, unknown>} [config]
 * @returns {T}
 */
function inProject(run, world = {}, config = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-mcp-"));
  const dropStore = useFakePlexus(world);
  const drop = () => {
    dropStore();
    fs.rmSync(cwd, { recursive: true, force: true });
  };
  let ran;
  try {
    writeConfig(cwd, { scope: "proj", ...config });
    ran = run(cwd);
  } catch (error) {
    drop();
    throw error;
  }
  if (ran instanceof Promise) return /** @type {T} */ (ran.finally(drop));
  drop();
  return ran;
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
 * @param {{ cwd: string, request: Record<string, unknown>, env?: Record<string, string>, args?: string[] }} options
 */
function serve({ cwd, request, env = {}, args = [] }) {
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
  const served = spawnSync(process.execPath, ["--import", plexusHook, binary, "mcp", ...args], {
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

/**
 * A server a test talks to for a whole session, as a host does, reading what
 * it writes as it writes it: what it says unasked, between requests, is what
 * a one-request server cannot show.
 *
 * @param {string} cwd
 */
async function session(cwd) {
  const { CLAUDE_PROJECT_DIR: _host, ...inherited } = process.env;
  const child = spawn(process.execPath, ["--import", plexusHook, binary, "mcp"], {
    cwd,
    env: { ...inherited, PHARO_AGENT_PROJECTION: "off" },
  });
  /** @type {Record<string, any>[]} */
  const messages = [];
  /** @type {{ wanted: (message: Record<string, any>) => boolean, found: (message: Record<string, any>) => void }[]} */
  const waiting = [];
  let stderr = "";
  let unread = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    unread += chunk;
    const lines = unread.split("\n");
    unread = lines.pop() ?? "";
    for (const line of lines.filter((each) => each.startsWith("{"))) {
      const message = JSON.parse(line);
      messages.push(message);
      for (const waiter of waiting.filter((each) => each.wanted(message))) {
        waiting.splice(waiting.indexOf(waiter), 1);
        waiter.found(message);
      }
    }
  });

  /**
   * @param {(message: Record<string, any>) => boolean} wanted
   * @param {string} what
   * @param {number} [withinMs]
   */
  function next(wanted, what, withinMs = 20_000) {
    const already = messages.find(wanted);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(waiter), 1);
        reject(new Error(`no ${what} within ${withinMs} ms; stderr: ${stderr}`));
      }, withinMs);
      const waiter = { wanted, found: (message) => { clearTimeout(timer); resolve(message); } };
      waiting.push(waiter);
    });
  }

  let lastId = 0;
  /** @param {Record<string, unknown>} message */
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   */
  async function request(method, params) {
    lastId += 1;
    const id = lastId;
    send({ id, method, ...(params ? { params } : {}) });
    const answer = await next((message) => message.id === id, `answer to ${method}`);
    if (answer.error) throw new Error(answer.error.message);
    return answer.result;
  }

  await request("initialize", {
    protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  send({ method: "notifications/initialized" });
  return {
    messages,
    request,
    next,
    get stderr() { return stderr; },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}

function listTools(cwd, env = {}, args = []) {
  const answer = serve({ cwd, request: { method: "tools/list" }, env, args });
  return { ...answer, tools: answer.result?.tools };
}

function callTool(cwd, name, toolArguments = {}) {
  return serve({ cwd, request: { method: "tools/call", params: { name, arguments: toolArguments } } });
}

function answerOf(result) {
  return JSON.parse(result.content[0].text);
}

/** The listings the fake store was asked for at an endpoint, as it records them. */
function listingsAt(url, op = "listTools") {
  return callsOf(op).filter((call) => call.url === url);
}

/**
 * @param {() => boolean} condition
 * @param {string} what
 * @param {number} withinMs
 */
async function eventually(condition, what, withinMs) {
  const givingUp = Date.now() + withinMs;
  while (!condition()) {
    if (Date.now() >= givingUp) throw new Error(`${what} not within ${withinMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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

test("every running image's tools follow the server's own, each taking an image", () => {
  inProject((cwd) => {
    const { served, tools } = listTools(cwd);

    assert.equal(served.status, 0, served.stderr);
    assert.deepEqual(tools.map((tool) => tool.name), [...projectToolNames, "class_get", "test_run"]);
    const image = tools.find((tool) => tool.name === "class_get").inputSchema.properties.image;
    assert.equal(image.description, "Image to call, one of dev, ci. A call that names none goes to dev, the default image.");
    assert.deepEqual(
      tools.find((tool) => tool.name === "class_get").inputSchema.required,
      undefined,
      "a call that names no image has the default to go to",
    );
    assert.equal(
      tools.find((tool) => tool.name === "class_get").description,
      "dev's",
      "a call that names no image meets the default image's schema",
    );
    assert.deepEqual(
      callsOf("listTools").map((call) => call.url).sort(),
      ["http://127.0.0.1:41000/", "http://127.0.0.1:42000/"],
    );
  }, {
    images: {
      "proj-ci": runningImage(42000, { tools: [
        { name: "class_get", description: "ci's", inputSchema: { type: "object" } },
        { name: "test_run", inputSchema: { type: "object" } },
      ] }),
      "proj-dev": runningImage(41000, { tools: [{ name: "class_get", description: "dev's", inputSchema: { type: "object", properties: {} } }] }),
      "proj-idle": pinnedImage({ tools: [{ name: "idle_tool", inputSchema: { type: "object" } }] }),
    },
  }, { defaultImage: "dev" });
});

// A call naming no image goes to the default, which answered -32601 for a
// tool only another image held, while the schema offered the default for it.
test("a tool's image names only the images that list it, and is required where the default does not", () => {
  inProject((cwd) => {
    const { served, tools } = listTools(cwd);

    assert.equal(served.status, 0, served.stderr);
    const testRun = tools.find((tool) => tool.name === "test_run").inputSchema;
    assert.equal(testRun.properties.image.description, "Image to call, one of ci. The default image, dev, does not list this tool.");
    assert.deepEqual(testRun.required, ["image"]);
    const defaultOnly = tools.find((tool) => tool.name === "class_comment").inputSchema;
    assert.equal(defaultOnly.properties.image.description, "Image to call, one of dev. A call that names none goes to dev, the default image.");
    assert.deepEqual(defaultOnly.required, undefined);
  }, {
    images: {
      "proj-ci": runningImage(42000, { tools: [{ name: "test_run", inputSchema: { type: "object" } }] }),
      "proj-dev": runningImage(41000, { tools: [{ name: "class_comment", inputSchema: { type: "object" } }] }),
    },
  }, { defaultImage: "dev" });
});

// Starting a default that does not exist is refused: there is nothing to
// start, so "not running" sent an agent to a dead end.
test("a default image that does not exist says so, in the schema and on a call", () => {
  inProject((cwd) => {
    const { served, tools } = listTools(cwd);

    assert.equal(served.status, 0, served.stderr);
    const schema = tools.find((tool) => tool.name === "class_create").inputSchema;
    assert.equal(
      schema.properties.image.description,
      "Image to call, one of p13. The default image, dev, does not exist: create it with image_create,"
        + " or choose another default with pharo-agent image use <name>.",
    );
    assert.deepEqual(schema.required, ["image"]);

    const { result, error } = callTool(cwd, "class_create", { name: "Foo" });
    assert.equal(result, undefined);
    assert.equal(
      error.message,
      "No image is named, and the default image dev does not exist. Running now: p13. Name one with image,"
        + " create it with image_create, or choose another default with pharo-agent image use <name>.",
    );
    assert.deepEqual(callsOf("callTool"), []);
  }, {
    images: {
      "proj-p13": runningImage(42000, { tools: [{ name: "class_create", inputSchema: { type: "object" } }] }),
    },
  }, { defaultImage: "dev" });
});

// A hung image was offered as a target in every tool it had not listed.
test("an image that does not answer is offered in no tool's image", () => {
  inProject((cwd) => {
    const { served, tools } = listTools(cwd);

    assert.equal(served.status, 0, served.stderr);
    assert.equal(
      tools.find((tool) => tool.name === "class_get").inputSchema.properties.image.description,
      "Image to call, one of dev. A call that names none goes to dev, the default image.",
    );
    assert.match(served.stderr, /image hung listed no tools/);
  }, {
    images: {
      "proj-dev": runningImage(41000, { tools: [{ name: "class_get", inputSchema: { type: "object" } }] }),
      "proj-hung": runningImage(42000, { unreachable: true }),
    },
  }, { defaultImage: "dev" });
});

// It runs, so "not running" would be wrong, and a call naming no image would
// wait on it.
test("a default image that does not answer is said to, where another image lists the tool", () => {
  inProject((cwd) => {
    const { served, tools } = listTools(cwd);

    assert.equal(served.status, 0, served.stderr);
    const schema = tools.find((tool) => tool.name === "class_get").inputSchema;
    assert.equal(schema.properties.image.description, "Image to call, one of ci. The default image, dev, does not answer.");
    assert.deepEqual(schema.required, ["image"]);
  }, {
    images: {
      "proj-ci": runningImage(42000, { tools: [{ name: "class_get", inputSchema: { type: "object" } }] }),
      "proj-dev": runningImage(41000, { unreachable: true }),
    },
  }, { defaultImage: "dev" });
});

// The listing waited for every image, other sessions' included, for as long
// as PLexus waits on each request: a minute and more for one that hung,
// before even image_stop was listed.
test("an image that hangs holds the list back by the listing timeout at most", () => {
  inProject((cwd) => {
    const started = Date.now();
    const { served, tools } = listTools(cwd);
    const elapsed = Date.now() - started;

    assert.equal(served.status, 0, served.stderr);
    assert.deepEqual(tools?.map((tool) => tool.name), [...projectToolNames, "class_get"], served.stdout);
    assert.equal(
      tools.at(-1).inputSchema.properties.image.description,
      "Image to call, one of dev. A call that names none goes to dev, the default image.",
    );
    assert.match(served.stderr, new RegExp(`image slow listed no tools: no answer within ${listingTimeoutMs / 1000} s`));
    assert.ok(elapsed < listingTimeoutMs + 3_000, `listed after ${elapsed} ms`);
  }, {
    images: {
      "proj-dev": runningImage(41000, { tools: [{ name: "class_get", inputSchema: { type: "object" } }] }),
      "proj-slow": runningImage(42000, { hangs: true, tools: [{ name: "class_get", inputSchema: { type: "object" } }] }),
    },
  }, { defaultImage: "dev" });
});

const listChanged = (message) => message.method === "notifications/tools/list_changed";

// Left out of a listing for missing the bound, a busy default image stayed
// out for the whole session: nothing listed again once it was done.
test("a default image that answers after the listing timeout gets its tools at the listing that follows", async () => {
  await inProject(async (cwd) => {
    const server = await session(cwd);
    try {
      const first = await server.request("tools/list");
      assert.deepEqual(first.tools.map((tool) => tool.name), projectToolNames);
      assert.match(server.stderr, /image dev listed no tools: no answer within/);
      assert.equal(server.messages.some(listChanged), false, "the image has not answered yet");

      changeImages({ "proj-dev": { busy: false } });
      await server.next(listChanged, "notifications/tools/list_changed", 5_000);
      const second = await server.request("tools/list");

      assert.deepEqual(second.tools.map((tool) => tool.name), [...projectToolNames, "class_get"]);
      assert.equal(
        second.tools.at(-1).inputSchema.properties.image.description,
        "Image to call, one of dev. A call that names none goes to dev, the default image.",
      );
    } finally {
      server.close();
    }
  }, {
    images: {
      "proj-dev": runningImage(41000, { busy: true, tools: [{ name: "class_get", inputSchema: { type: "object" } }] }),
    },
  }, { defaultImage: "dev" });
});

// A default busy until a test says otherwise, in a store whose PLexus gives
// up on a listing, after its two requests, a second after this server's
// listing stops waiting.
const busyDefaultUrl = "http://127.0.0.1:41000/";
const busyDefault = () => ({
  timeoutMs: (listingTimeoutMs + 1_000) / 2,
  images: {
    "proj-dev": runningImage(41000, { busy: true, tools: [{ name: "class_get", inputSchema: { type: "object" } }] }),
  },
});

// PLexus gives up on a listing after a minute on each of its two requests,
// and a listing that missed the bound failed with it: a default busy longer
// than that stayed out for the rest of the session, image_start refusing it
// as already running.
test("an image busy past PLexus's own timeout is asked again until it answers", async () => {
  await inProject(async (cwd) => {
    const server = await session(cwd);
    try {
      const first = await server.request("tools/list");
      assert.deepEqual(first.tools.map((tool) => tool.name), projectToolNames);

      // Given up on twice, the second time by an ask that missed the bound
      // itself, and asked again after each.
      await eventually(() => listingsAt(busyDefaultUrl).length >= 3, "a third listing of dev", 20_000);
      assert.equal(server.messages.some(listChanged), false, "the image has not answered yet");
      changeImages({ "proj-dev": { busy: false } });
      await server.next(listChanged, "notifications/tools/list_changed", 5_000);
      const second = await server.request("tools/list");

      assert.deepEqual(second.tools.map((tool) => tool.name), [...projectToolNames, "class_get"]);
    } finally {
      server.close();
    }
  }, busyDefault(), { defaultImage: "dev" });
});

// An image that stopped while left out has no tools to come back with.
test("an image left out that stops running is asked nothing more", async () => {
  await inProject(async (cwd) => {
    const server = await session(cwd);
    try {
      await server.request("tools/list");
      changeImages({ "proj-dev": { running: undefined } });
      const ended = () => listingsAt(busyDefaultUrl, "listToolsEnded");
      await eventually(() => ended().length >= 1, "the listing of dev to end", 5_000);
      await server.request("ping");

      assert.equal(listingsAt(busyDefaultUrl).length, 1, "a stopped image is not asked again");
      assert.equal(server.messages.some(listChanged), false);
    } finally {
      server.close();
    }
  }, busyDefault(), { defaultImage: "dev" });
});

// An image that fails a listing at once is not busy, and asking it again
// whenever it fails would ask it as fast as it fails.
test("an image left out whose listing then fails at once is asked again only at the next listing", async () => {
  await inProject(async (cwd) => {
    const server = await session(cwd);
    try {
      await server.request("tools/list");
      changeImages({ "proj-dev": { unreachable: true } });
      const ended = () => listingsAt(busyDefaultUrl, "listToolsEnded");
      await eventually(() => ended().length >= 2, "two listings of dev to end", 5_000);
      await server.request("ping");

      assert.equal(listingsAt(busyDefaultUrl).length, 2, "asked once more, once the listing left out failed");
      assert.equal(server.messages.some(listChanged), false);
    } finally {
      server.close();
    }
  }, busyDefault(), { defaultImage: "dev" });
});

// A host leaves by closing the server's input; one that left without
// killing the server left it asking an image busy for as long as it ran.
test("a server whose host has left asks an image left out nothing more", () => {
  inProject((cwd) => {
    const { served, tools } = listTools(cwd);

    assert.deepEqual(tools?.map((tool) => tool.name), projectToolNames, served.stdout);
    assert.equal(served.status, 0, `the server did not exit: ${served.error?.message}`);
    assert.equal(listingsAt(busyDefaultUrl).length, 1);
  }, busyDefault(), { defaultImage: "dev" });
});

test("a listing that left out several images that answer later says once that the list changed", async () => {
  const late = ["http://127.0.0.1:41000/", "http://127.0.0.1:42000/"];
  await inProject(async (cwd) => {
    const server = await session(cwd);
    try {
      const first = await server.request("tools/list");
      assert.deepEqual(first.tools.map((tool) => tool.name), projectToolNames);

      // Counted once both late listings have answered and the server has
      // read its input since: whatever it sends on hearing them is written
      // before its answer to the ping.
      changeImages({ "proj-ci": { busy: false }, "proj-dev": { busy: false } });
      await eventually(
        () => late.every((url) => listingsAt(url, "listToolsEnded").some((call) => call.answered)),
        "both late listings to answer",
        5_000,
      );
      await server.request("ping");
      assert.equal(server.messages.filter(listChanged).length, 1, "the host lists every image again at once");

      const second = await server.request("tools/list");
      assert.equal(
        second.tools.find((tool) => tool.name === "class_get").inputSchema.properties.image.description,
        "Image to call, one of dev, ci. A call that names none goes to dev, the default image.",
      );
    } finally {
      server.close();
    }
  }, {
    images: {
      "proj-ci": runningImage(42000, { busy: true, tools: [{ name: "class_get", inputSchema: { type: "object" } }] }),
      "proj-dev": runningImage(41000, { busy: true, tools: [{ name: "class_get", inputSchema: { type: "object" } }] }),
    },
  }, { defaultImage: "dev" });
});

// An agent that stopped every image and started only another one had no
// class_create: the list held the default image's tools or none.
test("a running image's tools are listed while the default image is stopped", () => {
  inProject((cwd) => {
    const { served, tools } = listTools(cwd);

    assert.equal(served.status, 0, served.stderr);
    assert.deepEqual(tools.map((tool) => tool.name), [...projectToolNames, "class_create"]);
    const schema = tools.at(-1).inputSchema;
    assert.match(schema.properties.image.description, /one of p13\. The default image, dev, is not running/);
    assert.deepEqual(schema.required, ["name", "image"], "a call that names no image has nowhere to go");
  }, {
    images: {
      "proj-dev": pinnedImage(),
      "proj-p13": runningImage(42000, { tools: [
        { name: "class_create", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
      ] }),
    },
  }, { defaultImage: "dev" });
});

test("the image the server is started with takes the default's place", () => {
  inProject((cwd) => {
    const { served, tools } = listTools(cwd, {}, ["--image", "ci"]);

    assert.equal(served.status, 0, served.stderr);
    const classGet = tools.find((tool) => tool.name === "class_get");
    assert.equal(classGet.description, "ci's");
    assert.match(classGet.inputSchema.properties.image.description, /one of ci, dev\. A call that names none goes to ci/);
  }, {
    images: {
      "proj-ci": runningImage(42000, { tools: [{ name: "class_get", description: "ci's", inputSchema: { type: "object" } }] }),
      "proj-dev": runningImage(41000, { tools: [{ name: "class_get", description: "dev's", inputSchema: { type: "object" } }] }),
    },
  }, { defaultImage: "dev" });
});

// image_list answered the project's default while every tool's image said
// that a call naming none went to the server's.
test("image_list names the image the server is started with as the default", () => {
  inProject((cwd) => {
    const { served, result } = serve({
      cwd,
      args: ["--image", "ci"],
      request: { method: "tools/call", params: { name: "image_list", arguments: {} } },
    });

    assert.equal(served.status, 0, served.stderr);
    const listed = answerOf(result);
    assert.equal(listed.defaultImage, "ci");
    assert.deepEqual(listed.images.map((image) => [image.name, image.isDefault]), [["ci", true], ["dev", false]]);
  }, { images: { "proj-ci": runningImage(42000), "proj-dev": runningImage(41000) } }, { defaultImage: "dev" });
});

test("a call that names no image goes to the default image while others run", () => {
  inProject((cwd) => {
    const { served, result } = callTool(cwd, "class_get", { name: "Point" });

    assert.equal(served.status, 0, served.stderr);
    assert.deepEqual(result.content, [{ type: "text", text: "nil" }]);
    assert.deepEqual(callsOf("callTool").map((call) => call.url), ["http://127.0.0.1:41000/"]);
  }, { images: { "proj-dev": runningImage(41000), "proj-p13": runningImage(42000) } }, { defaultImage: "dev" });
});

test("a call that names no image, while the default is stopped, names the running ones", () => {
  inProject((cwd) => {
    const { result, error } = callTool(cwd, "class_create", { name: "Foo" });

    assert.equal(result, undefined);
    assert.match(error.message, /default image dev is not running/);
    assert.match(error.message, /Running now: p13/);
    assert.deepEqual(callsOf("callTool"), [], "nothing is written into an image the call did not name");
  }, { images: { "proj-dev": pinnedImage(), "proj-p13": runningImage(42000) } }, { defaultImage: "dev" });
});

// The server's image was passed on as a name, so a call naming none, with
// that image stopped, was told to start it rather than which images run.
test("with --image, a call that names no image, while that image is stopped, names the running ones", () => {
  inProject((cwd) => {
    const { result, error } = serve({
      cwd,
      args: ["--image", "ci"],
      request: { method: "tools/call", params: { name: "class_get", arguments: { name: "Point" } } },
    });

    assert.equal(result, undefined);
    assert.equal(
      error.message,
      "No image is named, and the default image ci is not running. Running now: dev."
        + " Name one with image, or start ci with image_start.",
    );
    assert.deepEqual(callsOf("callTool"), []);
  }, { images: { "proj-ci": pinnedImage(), "proj-dev": runningImage(41000) } }, { defaultImage: "dev" });
});

// 0.17.1 said to start it; 0.18.0 passed on PLexus's bare fact.
test("a call to an image that is not running says to start it", () => {
  inProject((cwd) => {
    const { result, error } = callTool(cwd, "class_get", { image: "p13", name: "Point" });

    assert.equal(result, undefined);
    assert.match(error.message, /Image p13 is not running/);
    assert.match(error.message, /image_start/);
  }, { images: { "proj-dev": runningImage(41000), "proj-p13": pinnedImage() } }, { defaultImage: "dev" });
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
    assert.equal(answerOf(result).note, undefined, "a call that names no image already goes there");
  }, { images: { "proj-dev": pinnedImage() } }, { defaultImage: "dev" });
});

// An agent that started p13 sent every call without image, to the default
// image, and wrote its work there.
test("a start of an image other than the default says to name it in its tools' calls", () => {
  inProject((cwd) => {
    const { served, result } = callTool(cwd, "image_start", { name: "p13" });

    assert.equal(served.status, 0, served.stderr);
    assert.match(answerOf(result).note, /Pass image: "p13" to its tools/);
    assert.match(answerOf(result).note, /names no image goes to dev, the default image/);
  }, { images: { "proj-dev": runningImage(41000), "proj-p13": pinnedImage() } }, { defaultImage: "dev" });
});

test("a stop through the server says the tool list changed", () => {
  inProject((cwd) => {
    const { served, messages } = callTool(cwd, "image_stop", { name: "p13" });

    assert.equal(served.status, 0, served.stderr);
    assert.ok(messages.some((message) => message.method === "notifications/tools/list_changed"));
    assert.equal(readWorld().images["proj-p13"].running, undefined);
  }, { images: { "proj-dev": runningImage(41000), "proj-p13": runningImage(42000) } }, { defaultImage: "dev" });
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
