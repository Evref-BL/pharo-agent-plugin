import { createRequire } from "node:module";
import { PlexusError, callTool, listTools } from "@evref-bl/plexus";
import { olderMcpWarning, projectImages } from "./images.js";
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
 * }} Target
 */

/**
 * The image a call goes to, the one named or the default, and where it
 * answers. Asked for every call rather than kept: the image may have exited,
 * or been started again on another port, since the last one.
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
  if (own?.endpoint) return { name: defaultImage, images, endpoint: own.endpoint };
  const others = rows.filter((row) => row.endpoint).map((row) => row.name);
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
  return namedTarget(images, defaultImage);
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
 * @param {import("@evref-bl/plexus").Images} images
 * @param {string} name
 * @returns {Promise<Target>}
 */
async function namedTarget(images, name) {
  try {
    return { name, images, endpoint: await images.endpoint(name) };
  } catch (error) {
    // PLexus states the fact in its own words; starting it is this
    // package's to say. A VM that exited takes what was not saved with it.
    if (/** @type {{ code?: unknown }} */ (error)?.code !== "not-running") throw error;
    throw new PlexusError(
      "not-running",
      `Image ${name} is not running. Start it with image_start; it starts as it was last saved.`,
    );
  }
}

// An image whose Pharo MCP predates 2.1.0 resolves tools/call against the
// advertised list, so a tool it holds but does not advertise answers -32601.
// That is the loudest way an older MCP shows itself, and the message alone
// sends a reader looking for a tool that is right there.
const methodNotFound = "-32601";

export function toolFailureMessage(message, row) {
  const warning = row && message.includes(methodNotFound) ? olderMcpWarning(row) : undefined;
  return warning ? `${message}\n${warning}` : message;
}

/** @param {Target} target */
export async function callImageTool(target, toolName, argumentsValue) {
  try {
    return await callTool(target.endpoint, toolName, argumentsValue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(methodNotFound)) throw error;
    const row = await target.images.list(target.name).then(([found]) => found, () => undefined);
    throw new Error(toolFailureMessage(message, row));
  }
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

export function toolResult(data) {
  if (data && typeof data === "object" && Array.isArray(data.content)) {
    return data;
  }
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
