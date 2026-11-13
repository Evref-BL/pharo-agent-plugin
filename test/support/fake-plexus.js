// What this package's tests get for @evref-bl/plexus: its API, over a store
// that is a JSON file rather than a directory of images, and VMs that are
// entries in it. The file is named by PHARO_AGENT_FAKE_PLEXUS, so a test and
// the pharo-agent processes it spawns share one store, and every call is
// recorded in it for the test to read back.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultPharoMcpVersion } from "@evref-bl/plexus";

export { defaultPharoMcpVersion };

/** The module to --import into a spawned pharo-agent, so it gets this fake too. */
export const plexusHook = new URL("./plexus-hook.js", import.meta.url).href;

const worldVariable = "PHARO_AGENT_FAKE_PLEXUS";
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * @typedef {{
 *   tool: string,
 *   contains?: string,
 *   result?: unknown,
 *   error?: string,
 * }} Answer
 *
 * @typedef {{
 *   template?: string,
 *   category?: string,
 *   pharoVersion?: string,
 *   mcp?: { source: "pin", version: string } | { source: "script", script: string },
 *   everyStart?: string,
 *   building?: boolean,
 *   running?: { pids: number[], display?: string, endpoint?: { url: string, pid?: number }, endpointProblem?: string },
 *   startFails?: string,
 *   unreachable?: boolean,
 *   tools?: { name: string, description?: string, inputSchema?: Record<string, any> }[],
 *   answers?: Answer[],
 * }} FakeImage
 *
 * @typedef {{
 *   templates: { name: string, category: string }[],
 *   images: Record<string, FakeImage>,
 *   calls: Record<string, any>[],
 *   started: number,
 * }} World
 */

export const defaultTemplates = [
  { name: "Pharo 14.0 - 64bit (stable)", category: "Official distributions" },
  { name: "Pharo 13.0 - 64bit", category: "Official distributions" },
  { name: "Pharo 10.0 - 64bit", category: "Official distributions" },
  { name: "Pharo 10.0 - 64bit", category: "Pharo Mooc" },
];

export class PlexusError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = "PlexusError";
    this.code = code;
    if (details) this.details = details;
  }
}

function worldPath() {
  const file = process.env[worldVariable];
  if (!file) throw new Error(`${worldVariable} names no fake PLexus store`);
  return file;
}

/** @returns {World} */
export function readWorld() {
  return JSON.parse(fs.readFileSync(worldPath(), "utf8"));
}

/** @param {World} world */
function writeWorld(world) {
  fs.writeFileSync(worldPath(), `${JSON.stringify(world, null, 2)}\n`);
}

/**
 * A fresh store in a temporary directory, which this process and those it
 * spawns use from now on.
 *
 * @param {{ templates?: World["templates"], images?: Record<string, FakeImage> }} [world]
 */
export function useFakePlexus(world = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-fake-plexus-"));
  process.env[worldVariable] = path.join(directory, "world.json");
  writeWorld({ templates: defaultTemplates, images: {}, calls: [], started: 0, ...world });
  return () => fs.rmSync(directory, { recursive: true, force: true });
}

/** A stopped image as the pinned MCP makes it. */
export function pinnedImage(overrides = {}) {
  return {
    template: "Pharo 14.0 - 64bit (stable)",
    category: "Official distributions",
    pharoVersion: "140",
    mcp: { source: /** @type {const} */ ("pin"), version: defaultPharoMcpVersion },
    ...overrides,
  };
}

/** The same image, running and answering at `port`. */
export function runningImage(port, overrides = {}) {
  return pinnedImage({
    running: { pids: [port + 50000], display: "headless", endpoint: { url: `http://127.0.0.1:${port}/`, pid: port + 50000 } },
    ...overrides,
  });
}

/** The calls of one kind the fake was given, in order. */
export function callsOf(op) {
  return readWorld().calls.filter((call) => call.op === op);
}

/**
 * @param {World} world
 * @param {string | undefined} scope
 * @param {string} diskName
 */
function row(world, scope, diskName) {
  const image = world.images[diskName];
  const running = image.running;
  return {
    name: scope ? diskName.slice(scope.length + 1) : diskName,
    diskName,
    path: `/fake-plexus/profiles/images/${diskName}/${diskName}.image`,
    running: Boolean(running),
    pids: running?.pids ?? [],
    ...(running ? { display: running.display ?? "headless" } : {}),
    ...(running?.endpoint ? { endpoint: running.endpoint } : {}),
    ...(running && !running.endpoint
      ? { endpointProblem: running.endpointProblem ?? "not started by this PLexus" }
      : {}),
    ...(image.building ? { building: true } : {}),
    ...(image.template ? { template: image.template } : {}),
    ...(image.pharoVersion ? { pharoVersion: image.pharoVersion } : {}),
    ...(image.mcp ? { mcp: image.mcp } : {}),
    ...(image.everyStart ? { everyStart: image.everyStart } : {}),
  };
}

export class Images {
  /** @param {{ home?: string, scope?: string }} [options] */
  constructor(options = {}) {
    this.scope = options.scope;
  }

  /** @param {string} name */
  diskName(name) {
    if (!namePattern.test(name)) {
      throw new PlexusError("invalid-name", `${JSON.stringify(name)} is not an image name.`);
    }
    return this.scope ? `${this.scope}-${name}` : name;
  }

  /**
   * @param {string} op
   * @param {Record<string, unknown>} [details]
   */
  record(op, details = {}) {
    const world = readWorld();
    world.calls.push({ op, scope: this.scope, ...details });
    return world;
  }

  /**
   * @param {World} world
   * @param {string} name
   */
  existing(world, name) {
    const diskName = this.diskName(name);
    if (!world.images[diskName]) {
      throw new PlexusError("no-such-image", `No image ${name}.`);
    }
    return diskName;
  }

  async templates() {
    const world = this.record("templates");
    writeWorld(world);
    return world.templates.map((template) => {
      const categories = world.templates.filter((each) => each.name === template.name);
      return { ...template, ...(categories.length > 1 ? { ambiguous: /** @type {const} */ (true) } : {}) };
    });
  }

  /** @param {string} [name] */
  async list(name) {
    const world = this.record("list", name === undefined ? {} : { name });
    writeWorld(world);
    if (name !== undefined) {
      return [row(world, this.scope, this.existing(world, name))];
    }
    return Object.keys(world.images)
      .filter((diskName) => !this.scope || diskName.startsWith(`${this.scope}-`))
      .sort()
      .map((diskName) => row(world, this.scope, diskName));
  }

  /**
   * @param {string} name
   * @param {{ template: string, category?: string, script?: string, everyStart?: boolean }} options
   */
  async create(name, options) {
    const world = this.record("create", { name, options });
    writeWorld(world);
    const diskName = this.diskName(name);
    if (world.images[diskName]) {
      throw new PlexusError("image-exists", `Image ${name} exists.`);
    }
    if (options.everyStart && !options.script) {
      throw new PlexusError("script-not-found", "everyStart needs a script");
    }
    if (options.script && !fs.existsSync(path.resolve(options.script))) {
      throw new PlexusError("script-not-found", `No script at ${options.script}.`);
    }
    const offering = world.templates.filter((template) => template.name === options.template
      && (options.category === undefined || template.category === options.category));
    if (offering.length === 0) {
      throw new PlexusError("unknown-template", `No template ${options.template}.`);
    }
    if (offering.length > 1) {
      throw new PlexusError(
        "ambiguous-template",
        `Template ${options.template} is in ${offering.map((template) => template.category).join(" and ")}.`,
      );
    }
    const script = options.script ? path.resolve(options.script) : undefined;
    world.images[diskName] = {
      template: options.template,
      category: offering[0].category,
      mcp: script ? { source: "script", script } : { source: "pin", version: defaultPharoMcpVersion },
      ...(options.everyStart ? { everyStart: script } : {}),
    };
    writeWorld(world);
    return { ...row(world, this.scope, diskName), fromBase: !script, seconds: 0 };
  }

  /**
   * @param {string} name
   * @param {{ display?: "headless" | "interactive", timeoutMs?: number }} [options]
   */
  async start(name, options = {}) {
    const world = this.record("start", { name, options });
    writeWorld(world);
    const diskName = this.existing(world, name);
    const image = world.images[diskName];
    if (image.building) throw new PlexusError("building", `Image ${name} is still being created.`);
    if (image.running) {
      throw new PlexusError(
        "image-running",
        `Image ${name} is already running as pid ${image.running.pids.join(", ")}.`,
        { pids: image.running.pids },
      );
    }
    if (image.startFails) throw new PlexusError("start-failed", image.startFails);
    world.started += 1;
    const port = 40000 + world.started;
    const display = options.display ?? "headless";
    const endpoint = { url: `http://127.0.0.1:${port}/`, pid: port + 50000 };
    image.running = { pids: [endpoint.pid], display, endpoint };
    writeWorld(world);
    return { name, pids: [endpoint.pid], endpoint, display, seconds: 0 };
  }

  /** @param {string} name */
  async stop(name) {
    const world = this.record("stop", { name });
    writeWorld(world);
    const diskName = this.existing(world, name);
    const killed = world.images[diskName].running?.pids ?? [];
    delete world.images[diskName].running;
    writeWorld(world);
    return { name, killed };
  }

  /** @param {string} name */
  async delete(name) {
    const world = this.record("delete", { name });
    writeWorld(world);
    const diskName = this.existing(world, name);
    if (world.images[diskName].running) {
      throw new PlexusError("image-running", `Image ${name} is running.`);
    }
    delete world.images[diskName];
    writeWorld(world);
    return { name };
  }

  /** @param {string} name */
  async endpoint(name) {
    const world = this.record("endpoint", { name });
    writeWorld(world);
    const image = world.images[this.existing(world, name)];
    if (!image.running) throw new PlexusError("not-running", `Image ${name} is not running.`);
    if (!image.running.endpoint) {
      throw new PlexusError("no-endpoint", `Image ${name} runs without an endpoint: ${image.running.endpointProblem}.`);
    }
    return image.running.endpoint;
  }
}

/**
 * @param {World} world
 * @param {{ url: string }} endpoint
 */
function answering(world, endpoint) {
  const found = Object.entries(world.images)
    .find(([, image]) => image.running?.endpoint?.url === endpoint.url);
  if (!found || found[1].unreachable) {
    throw new Error(`fetch failed: nothing answers at ${endpoint.url}`);
  }
  return found;
}

/** @param {{ url: string }} endpoint */
export async function listTools(endpoint) {
  const world = readWorld();
  world.calls.push({ op: "listTools", url: endpoint.url });
  writeWorld(world);
  return answering(world, endpoint)[1].tools ?? [];
}

/**
 * @param {{ url: string }} endpoint
 * @param {string} name
 * @param {Record<string, unknown>} [args]
 */
export async function callTool(endpoint, name, args = {}) {
  const world = readWorld();
  world.calls.push({ op: "callTool", url: endpoint.url, tool: name, arguments: args });
  writeWorld(world);
  const [, image] = answering(world, endpoint);
  const answer = (image.answers ?? []).find((each) => each.tool === name
    && (each.contains === undefined || JSON.stringify(args).includes(each.contains)));
  if (answer?.error) throw new Error(answer.error);
  return answer?.result ?? { content: [{ type: "text", text: "nil" }] };
}
