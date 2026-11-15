import { callImageTool, listImageTools } from "./gateway.js";
import { projectImages } from "./images.js";
import { readConfig, resolveImageName } from "./project.js";
import {
  forgetProjection,
  liveProjection,
  recordProjection,
  resolveMountPath,
  smalltalkString,
} from "./runtime.js";

export const pifsRelease = "v0.12.1";

// Set to `off`, no image mounts a source projection, wherever it runs.
const projectionVariable = "PHARO_AGENT_PROJECTION";

// The systems PIFS releases a daemon for.
const projectedPlatforms = ["darwin", "linux"];

/**
 * Whether to ask the image for a source projection.
 *
 * Whether this machine can mount is the PIFS daemon's to say: macOS needs
 * nothing, Linux needs fuse3, and the daemon names what is missing. A
 * projection that fails leaves the image running with that reason as its
 * warning, so this answers no only where asking is wasted, on a system PIFS
 * has no daemon for, or forbidden.
 *
 * A machine that could mount may still be one that must not, so the
 * environment can turn projections off before anything is asked.
 *
 * Turned off, or on a system PIFS has no daemon for, no source mounts by
 * choice, and nothing is said: a start's answer without a mount says there is
 * none. A setting it does not take is a mistake, and its reason is said.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   platform?: string,
 * }} [host]
 * @returns {{ available: true } | { available: false, chosen: true } | { available: false, reason: string }}
 */
export function projectionAvailability(host = {}) {
  const setting = (host.env ?? process.env)[projectionVariable];
  const platform = host.platform ?? process.platform;
  if (setting === "off") return { available: false, chosen: true };
  if (setting) {
    // Any other value fails safe: an opt-out that ignored a typo, or a 0,
    // would mount on the very machine that asked not to be mounted on.
    return {
      available: false,
      reason: `${projectionVariable} takes only off, and is ${JSON.stringify(setting)}.`
        + " Unset it to mount sources where the platform allows.",
    };
  }
  if (!projectedPlatforms.includes(platform)) return { available: false, chosen: true };
  return { available: true };
}

// The daemon's own reasons end without a period.
function sentence(text) {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** @param {string} text */
function withoutFinalPeriod(text) {
  return text.replace(/\.$/, "");
}

// The class-side PIFSServer messages this plugin sends into the image. The
// release automation checks that a published PIFS still implements them: a pin
// bump that leaves a removed selector in place passes every test here, because
// the tests read generated source, and fails only in a live image.
export const pifsSelectors = ["startMountedAt:named:", "stopOn:"];

export function pifsStartCode(mountPath, imageName) {
  // A projection that cannot mount answers why, as a string, rather than
  // failing the evaluation: the reason is the daemon's, and becomes the
  // warning of an image that keeps running.
  return `[ Metacello new
		baseline: 'PharoImageFS';
		repository: 'github://Evref-BL/pharo-image-fs:${pifsRelease}/src';
		load: 'Core'.
	((Smalltalk globals at: #PIFSServer)
		startMountedAt: ${smalltalkString(mountPath)} asFileReference
		named: ${smalltalkString(imageName)}) port ]
	on: Error
	do: [ :error | error messageText asString ]`;
}

/**
 * What a projection start answered: the port serving it, why PIFS could not
 * mount, or nothing readable.
 *
 * @param {string | undefined} printString
 * @returns {{ port: number } | { reason: string } | undefined}
 */
export function projectionStartOutcome(printString) {
  // The value comes first; MCP appends warnings, the Transcript and a
  // truncation mark on the lines after it.
  const text = printString ?? "";
  const digits = /^(\d+)(?:\n|$)/.exec(text);
  if (digits && Number(digits[1]) > 0) return { port: Number(digits[1]) };
  // A string prints quoted, its quotes doubled, and a long one is cut short
  // of its closing quote, before the truncation mark.
  const quoted = /^'((?:[^']|'')*)(?:'|$)/.exec(text);
  if (!quoted) return undefined;
  const literal = quoted[1].split("\n[truncated")[0].replaceAll("''", "'").trim();
  return {
    reason: `${sentence(literal)} Set ${projectionVariable}=off to start images without trying to mount.`,
  };
}

// How long the image may take over the projection start: a Metacello load of
// PIFS from GitHub on a cold image, the daemon, then a mount wait of at most
// 10 s. An MCP with an evaluation time limit stops an evaluation at 30 s
// unless told otherwise, which a cold start may outlast. The load alone took
// 4.9 s in a new image with no PIFS clone; the whole start, daemon and mount
// with it, is not timed, and the one trace that holds one, pifs-1's, created,
// started and mounted in 29.7 s in all. This leaves four times that. The call
// waits at least this plus 30 s.
export const pifsStartSeconds = 120;

export function pifsStopCode(projectionPort) {
  return `(Smalltalk globals at: #PIFSServer) stopOn: ${projectionPort}`;
}

function namedPrintString(value) {
  // Structured results name the print string, somewhere under the envelope,
  // and reach us either as an object or as JSON inside a text part.
  if (typeof value === "string") {
    try {
      return namedPrintString(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.resultPrintString === "string") return value.resultPrintString;
  for (const each of Object.values(value)) {
    const found = namedPrintString(each);
    if (found) return found;
  }
  return undefined;
}

function textPartText(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.content)) {
    return undefined;
  }
  const part = result.content.find(
    (candidate) =>
      candidate
      && candidate.type === "text"
      && typeof candidate.text === "string",
  );
  const text = part?.text.trim();
  return text === "" ? undefined : text;
}

export function resultPrintString(result) {
  // A server answering with structured content names the print string. In the
  // content-only mode every MCP server defaults to, the text part is the print
  // string, so a bare `60341` arrives as the whole answer.
  return namedPrintString(result) ?? textPartText(result);
}

/**
 * What PIFS answered: its port, or why it could not mount. An answer that
 * reads as neither is nothing, and goes to the host's log as it came. An
 * error the image answers instead, such as an evaluation stopped at its time
 * limit, is thrown with the line that says what happened.
 *
 * @param {import("./gateway.js").Target} target
 * @param {string} mountPath
 * @param {string} imageName
 */
/**
 * The tool an image runs Smalltalk with, as it lists it: `evaluate`, or
 * `image_evaluate` in an image whose MCP predates the rename. An image that
 * lists neither has an MCP older still, which held `image_evaluate` without
 * listing it.
 *
 * @param {{ name: string, inputSchema?: any }[]} tools
 */
export function evaluationTool(tools) {
  return tools.find((tool) => tool.name === "evaluate") ?? tools.find((tool) => tool.name === "image_evaluate");
}

async function startProjection(target, mountPath, imageName) {
  // Only an image whose MCP lists the limit is given one: an older MCP
  // refuses an argument it does not know. The listing is the image's answer
  // too, so one that fails fails the mount.
  const evaluate = evaluationTool(await listImageTools(target));
  const limited = evaluate?.inputSchema?.properties?.timeoutSeconds !== undefined;
  const result = await callImageTool(
    target,
    evaluate?.name ?? "image_evaluate",
    { code: pifsStartCode(mountPath, imageName), ...(limited ? { timeoutSeconds: pifsStartSeconds } : {}) },
    limited && evaluate ? { inputSchema: evaluate.inputSchema } : {},
  );
  if (result?.isError === true) {
    // The code catches PIFS's errors, so this is the image's own failure:
    // the code stopped at its limit, never started, or did not compile. Its
    // first line says which; the lines after it, where the code stopped and
    // what the image advises whoever wrote the code, go to the host's log.
    const text = textPartText(result);
    if (text?.includes("\n")) console.error(`pharo-agent: ${target.name} answered the PIFS start with: ${text}`);
    throw new Error(text?.split("\n")[0].trim() || "the image answered with an error and no text");
  }
  // A refusal is PIFS's own: it stopped what it had started.
  const outcome = projectionStartOutcome(resultPrintString(result));
  if (!outcome) {
    console.error(`pharo-agent: PIFS answered no projection port for ${target.name}: ${JSON.stringify(result).slice(0, 500)}`);
  }
  return outcome;
}

/**
 * Start an image, the default one when none is named, and mount its source
 * where the machine allows it. The image as listed before the start comes
 * back with it, for the answer: what every start files in, and which MCP it
 * holds.
 *
 * @param {string} projectRoot
 * @param {string} [name]
 * @param {{ display?: "headless" | "interactive" }} [options]
 * @returns {Promise<import("./answers.js").AgentStart>}
 */
export async function startAgentImage(projectRoot, name, options = {}) {
  const images = projectImages(projectRoot);
  const resolved = resolveImageName(projectRoot, name);
  const [row] = await images.list(resolved);
  const started = await images.start(resolved, options.display ? { display: options.display } : {});
  // PLexus starts only an image no VM runs, so a projection recorded under
  // this name belonged to a VM that is gone.
  forgetProjection(projectRoot, resolved);
  const availability = projectionAvailability();
  if (!availability.available) {
    return { ...started, row, ...("reason" in availability ? { notMounted: availability.reason } : {}) };
  }
  const mountPath = resolveMountPath(projectRoot, readConfig(projectRoot), resolved);
  let projection;
  let failure;
  try {
    projection = await startProjection({ name: resolved, images, endpoint: started.endpoint }, mountPath, row.diskName);
    if (!projection) failure = "PIFS answered no projection port";
  } catch (error) {
    failure = `mounting its source failed: ${withoutFinalPeriod(error instanceof Error ? error.message : String(error))}`;
  }
  if (!projection) {
    // Nothing says whether PIFS mounted, so stop the image rather than keep
    // a mount nothing records: its daemon unmounts once the image is gone.
    // Said as what happened to the image, since the call that failed is this
    // package's, not one the agent made.
    try {
      await images.stop(resolved);
    } catch (stopError) {
      throw new Error(`Image ${resolved} started, but ${failure}. Stopping it again failed as well: `
        + `${withoutFinalPeriod(stopError instanceof Error ? stopError.message : String(stopError))}.`);
    }
    throw new Error(`Image ${resolved} started, but was stopped again because ${failure}.`
      + ` Start it with ${projectionVariable}=off to skip the mount.`);
  }
  if ("reason" in projection) {
    // The image and its tools are the point; the projection is the extra this
    // package bundles where the machine allows it.
    return { ...started, row, notMounted: projection.reason };
  }
  recordProjection(projectRoot, resolved, {
    mountPath,
    projectionPort: projection.port,
    pifsRelease,
    pids: started.pids,
  });
  return { ...started, row, mountPath, projectionPort: projection.port };
}

/**
 * Stop one image, the default one when none is named, or with `all`, every
 * image of this project that a PLexus start left answering. A VM started by
 * hand, or by an older PLexus, has no endpoint, and only a stop that names
 * its image reaches it: `all` leaves it running, and says which it left.
 *
 * @param {string} projectRoot
 * @param {string} [name]
 * @param {{ all?: boolean }} [options]
 * @returns {Promise<import("./answers.js").AgentStop>}
 */
export async function stopAgentImage(projectRoot, name, options = {}) {
  if (options.all && name !== undefined) {
    throw new Error("Stopping every image takes no image name.");
  }
  const images = projectImages(projectRoot);
  const listed = options.all ? await images.list() : await images.list(resolveImageName(projectRoot, name));
  const rows = options.all ? listed.filter((row) => row.endpoint) : listed;
  const stopped = [];
  for (const row of rows) {
    const projection = liveProjection(projectRoot, row);
    if (projection && row.endpoint) {
      try {
        const target = { name: row.name, images, endpoint: row.endpoint };
        await callImageTool(target, evaluationTool(await listImageTools(target))?.name ?? "image_evaluate", {
          code: pifsStopCode(projection.projectionPort),
        });
      } catch (error) {
        // The stop goes on: the projection's daemon unmounts once its image
        // is gone, so a failed unmount leaves nothing behind for long, and
        // nothing for the answer to say. The host's log keeps it.
        console.error(`pharo-agent: PIFS did not unmount ${row.name}: ${error.message}`);
      }
    }
    stopped.push(await images.stop(row.name));
    forgetProjection(projectRoot, row.name);
  }
  return { stopped, left: options.all ? listed.filter((row) => row.running && !row.endpoint) : [] };
}
