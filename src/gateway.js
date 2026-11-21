import { createRequire } from "node:module";
import { PlexusError, callTool, listTools } from "@evref-bl/plexus";
import { projectImages } from "./images.js";
import { toolContractFrom } from "./mcpYaml.js";
import { resolveImageName } from "./project.js";

// Read rather than restate: a hard-coded version is one more place for a
// release to forget, and the host shows this one to the user.
export const { version } = createRequire(import.meta.url)("../package.json");

/**
 * @typedef {{
 *   name: string,
 *   images: import("@evref-bl/plexus").Images,
 *   endpoint: import("@evref-bl/plexus").Endpoint,
 *   alsoRunning?: string[],
 * }} Target
 */

/**
 * The image a call goes to, the one named or the default, and where it
 * answers. Asked for every call rather than kept: the image may have exited,
 * or been started again on another port, since the last one. For a call
 * that names none, `alsoRunning` is the project's other images that take
 * calls, which its caller may have meant.
 *
 * @param {string} projectRoot
 * @param {string} [name]
 * @param {{ defaultImage?: string }} [options] the image a call naming none
 *   goes to, when a server was started with one in place of the project's
 * @returns {Promise<Target>}
 */
export async function imageTarget(projectRoot, name, options = {}) {
  const images = projectImages(projectRoot);
  if (name !== undefined) return namedTarget(images, name);
  const chosen = options.defaultImage !== undefined;
  const defaultImage = options.defaultImage ?? resolveImageName(projectRoot, undefined);
  const rows = await images.list();
  const own = rows.find((row) => row.name === defaultImage);
  const others = rows.filter((row) => row.endpoint && row.name !== defaultImage).map((row) => row.name);
  if (own?.endpoint) return { name: defaultImage, images, endpoint: own.endpoint, alsoRunning: others };
  const running = others.length > 0 ? ` Running now: ${others.join(", ")}.` : "";
  const naming = others.length > 0 ? ["name one with image"] : [];
  if (own === undefined) {
    // Not "not running": a start is refused when there is nothing to start.
    throw Object.assign(
      new Error(
        `No image is named, and the default image ${defaultImage} does not exist.${running} `
          + `${sentence(oneOf([...naming, ...missingDefaultRemedies(chosen)]))}`,
      ),
      { code: "no-such-default" },
    );
  }
  if (!own.running && others.length > 0) {
    // Not sent to one of them: it may be another session's, and the caller
    // did not say it meant it.
    throw new PlexusError(
      "not-running",
      `No image is named, and the default image ${defaultImage} is not running.${running} `
        + `${sentence(oneOf([...naming, `start ${defaultImage} with image_start`]))}`,
    );
  }
  return { ...(await namedTarget(images, defaultImage)), alsoRunning: others };
}

/**
 * How to come by a default image that does not exist. The project's default
 * can be chosen again; the one a server was started with stays that server's.
 *
 * @param {boolean} chosen whether a server was started with it
 */
function missingDefaultRemedies(chosen) {
  return [
    "create it with image_create",
    ...(chosen ? [] : ["choose another default with pharo-agent image use <name>"]),
  ];
}

/**
 * What an image tool's `image` argument says of a default image that does
 * not exist, as a call naming none is told it.
 *
 * @param {boolean} chosen whether a server was started with it
 */
export function missingDefault(chosen) {
  return `does not exist: ${oneOf(missingDefaultRemedies(chosen))}`;
}

/** "a", "a, or b", "a, b, or c". */
function oneOf(clauses) {
  return clauses.length < 2 ? clauses.join("")
    : `${clauses.slice(0, -1).join(", ")}, or ${clauses.at(-1)}`;
}

function sentence(clause) {
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;
}

/**
 * Where the image answers, or PLexus's refusal, which says why it does not
 * and what to do: not running, starting, or running without taking calls.
 *
 * @param {import("@evref-bl/plexus").Images} images
 * @param {string} name
 * @returns {Promise<Target>}
 */
async function namedTarget(images, name) {
  return { name, images, endpoint: await images.endpoint(name) };
}

// Raises the least a forwarded call waits: a call to a tool that keeps no
// time limit of its own, or whose schema no listing gave, waits only that.
const callSecondsVariable = "PHARO_AGENT_CALL_SECONDS";

/** PLexus's minute: a forwarded call never waits less than it did before the variable. */
const leastCallSeconds = 60;

let callSecondsRefused = false;

/**
 * The least a forwarded call waits for its answer, and what the handshake
 * before it waits: PLexus's minute, or the whole number of seconds
 * PHARO_AGENT_CALL_SECONDS gives when that is more. Any other value is
 * ignored, and said once per process on stderr, which reaches a host's log.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function callMinimumMs(env = process.env) {
  const setting = env[callSecondsVariable];
  if (!setting) return leastCallSeconds * 1000;
  if (/^\d+$/.test(setting)) return Math.max(Number(setting), leastCallSeconds) * 1000;
  if (!callSecondsRefused) {
    callSecondsRefused = true;
    console.error(`pharo-agent: ${callSecondsVariable} takes a whole number of seconds, not ${JSON.stringify(setting)};`
      + ` waiting at least ${leastCallSeconds} s.`);
  }
  return leastCallSeconds * 1000;
}

/**
 * One call to an image tool. It waits longer than the call's own time limit,
 * read from its `timeoutSeconds` or the default the image's `inputSchema`
 * lists, so that the image's answer to a call it stopped arrives first; and no
 * longer than `signal` lets it.
 *
 * It rejects with PLexus's error as it is, its `kind` saying whether the
 * image answered or got the call at all. This package's own calls go through
 * here too, the PIFS start and stop among them, so what a failure did to the
 * image is said only where a call the agent made is answered.
 *
 * @param {Target} target
 * @param {string} toolName
 * @param {Record<string, unknown>} argumentsValue
 * @param {{ inputSchema?: import("@modelcontextprotocol/sdk/types.js").Tool["inputSchema"], signal?: AbortSignal }} [options]
 */
export async function callImageTool(target, toolName, argumentsValue, options = {}) {
  return callTool(target.endpoint, toolName, argumentsValue, {
    ...(options.inputSchema ? { inputSchema: options.inputSchema } : {}),
    minimumMs: callMinimumMs(),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * @param {Target} target
 * @param {{ timeoutMs?: number, answeredLate?: () => void, signal?: AbortSignal }} [options]
 *   how long the whole listing may take, PLexus's own timeout bounding each
 *   of its two requests rather than the pair; what to do when an image that
 *   missed it answers after all, which `followLate` waits for; and when
 *   there is nobody left to tell.
 */
export async function listImageTools(target, options = {}) {
  const { timeoutMs, answeredLate, signal } = options;
  const listing = listTools(target.endpoint);
  if (timeoutMs === undefined) return listing;
  const tools = await within(listing, timeoutMs);
  if (tools !== missed) return tools;
  if (answeredLate) void followLate(target, listing, { timeoutMs, answeredLate, signal });
  throw new Error(`no answer within ${timeoutMs / 1000} s`);
}

const missed = Symbol("missed the bound");

/**
 * The listing's own outcome, or `missed` when the bound passes first.
 *
 * @template T
 * @param {Promise<T>} listing
 * @param {number} timeoutMs
 * @returns {Promise<T | typeof missed>}
 */
async function within(listing, timeoutMs) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const bound = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs, missed); });
  try {
    return await Promise.race([listing, bound]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An image that missed the bound, waited on until it answers: one evaluating
 * something long answers once it is done. PLexus gives up on a listing after
 * its own timeout, a minute, on each of its two requests, so a listing that
 * fails then is asked again while the image runs, at the endpoint PLexus has
 * for it now, and bounded as the first was. Nothing else asks it: the wait
 * ends when the image answers, when it stops, when an ask fails within the
 * bound, which is the image failing rather than busy and would be asked as
 * fast as it fails, or when nobody is left to tell.
 *
 * @param {Target} target
 * @param {Promise<unknown>} listing the one that missed the bound
 * @param {{ timeoutMs: number, answeredLate: () => void, signal?: AbortSignal }} options
 */
async function followLate(target, listing, { timeoutMs, answeredLate, signal }) {
  let late = listing;
  for (;;) {
    try {
      await late;
      answeredLate();
      return;
    } catch {
      // Given up on after the bound: the image may still be busy.
    }
    if (signal?.aborted) return;
    let endpoint;
    try {
      endpoint = await target.images.endpoint(target.name);
    } catch {
      return; // stopped, or gone: nothing to wait for
    }
    late = listTools(endpoint);
    let answer;
    try {
      answer = await within(late, timeoutMs);
    } catch {
      return; // failing, not busy: the next listing asks it again
    }
    if (answer !== missed) {
      answeredLate();
      return;
    }
  }
}

/**
 * A tool's contract: from the advertised list when it is there, otherwise
 * from tool_get, which reaches the rest of the catalogue.
 *
 * @param {Target} target
 * @param {string} toolName
 */
export async function toolContract(target, toolName) {
  const advertised = (await listImageTools(target)).find((tool) => tool.name === toolName);
  if (advertised) return advertised;
  const answer = /** @type {{ isError?: boolean, content?: { text?: string }[] }} */ (
    await callImageTool(target, "tool_get", { name: toolName })
  );
  const contract = answer?.isError ? undefined
    : toolContractFrom((answer?.content ?? []).map((part) => part.text ?? "").join("\n"));
  if (!contract) {
    throw new Error(`Image ${target.name} has no tool ${toolName}. pharo-agent tool_search <words> finds one.`);
  }
  return contract;
}

/**
 * An image tool as this server lists it: with an `image` argument naming the
 * images that list it. It is required where the default image is not among
 * them, since a call naming none goes to the default.
 *
 * @param {{ inputSchema?: { properties?: Record<string, unknown>, required?: string[] } }} tool
 * @param {string[]} holders the images that list the tool
 * @param {string} [defaultImage]
 * @param {string} [absence] why the default image lists no tool at all, when
 *   it does not: "is not running", for one
 */
export function withImageSelector(tool, holders, defaultImage, absence) {
  const inputSchema = tool.inputSchema ?? {};
  const defaultHolds = defaultImage !== undefined && holders.includes(defaultImage);
  const fallback = defaultImage === undefined ? ""
    : defaultHolds ? ` A call that names none goes to ${defaultImage}, the default image.`
    : ` The default image, ${defaultImage}, ${absence ?? "does not list this tool"}.`;
  const properties = {
    ...(inputSchema.properties ?? {}),
    image: {
      type: "string",
      description: `Image to call, one of ${holders.join(", ")}.${fallback}`,
    },
  };
  return {
    ...tool,
    inputSchema: {
      ...inputSchema,
      properties,
      ...(defaultHolds ? {} : { required: [...(inputSchema.required ?? []), "image"] }),
    },
  };
}
