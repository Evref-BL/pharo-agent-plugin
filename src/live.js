import { callImageTool } from "./gateway.js";
import { olderMcpWarning, projectImages } from "./images.js";
import { readConfig, resolveImageName } from "./project.js";
import {
  forgetProjection,
  readProjections,
  recordProjection,
  resolveMountPath,
  smalltalkString,
} from "./runtime.js";

export const pifsRelease = "v0.12.0";

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
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   platform?: string,
 * }} [host]
 */
export function projectionAvailability(host = {}) {
  const setting = (host.env ?? process.env)[projectionVariable];
  const platform = host.platform ?? process.platform;
  if (setting === "off") {
    return {
      available: false,
      reason: `Source projections are turned off by ${projectionVariable}=off.`,
    };
  }
  if (setting) {
    // Any other value fails safe: an opt-out that ignored a typo, or a 0,
    // would mount on the very machine that asked not to be mounted on.
    return {
      available: false,
      reason: `Source projections are off: ${projectionVariable} takes only off,`
        + ` and is ${JSON.stringify(setting)}. Unset it to mount them where the platform allows.`,
    };
  }
  if (!projectedPlatforms.includes(platform)) {
    return {
      available: false,
      reason: `PIFS mounts source projections on macOS and Linux, not on this platform (${platform}).`,
    };
  }
  return { available: true };
}

// The daemon's own reasons end without a period.
function sentence(text) {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function projectionUnavailableWarning(name, reason) {
  return `${sentence(reason)} Image ${name} is running with its Pharo tools and no`
    + " source projection; read and edit its code through the tools.";
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
 * @param {import("./gateway.js").Target} target
 * @param {string} mountPath
 * @param {string} imageName
 */
async function startProjection(target, mountPath, imageName) {
  const result = await callImageTool(target, "image_evaluate", {
    code: pifsStartCode(mountPath, imageName),
  });
  // A refusal is PIFS's own: it stopped what it had started.
  const outcome = projectionStartOutcome(resultPrintString(result));
  if (!outcome) {
    throw new Error(`PIFS did not report a projection port: ${JSON.stringify(result).slice(0, 500)}`);
  }
  return outcome;
}

/**
 * Start an image, the default one when none is named, and mount its source
 * where the machine allows it.
 *
 * @param {string} projectRoot
 * @param {string} [name]
 * @param {{ display?: "headless" | "interactive" }} [options]
 * @returns {Promise<Awaited<ReturnType<import("@evref-bl/plexus").Images["start"]>>
 *   & { mountPath?: string, projectionPort?: number, warning?: string }>}
 */
export async function startAgentImage(projectRoot, name, options = {}) {
  const images = projectImages(projectRoot);
  const resolved = resolveImageName(projectRoot, name);
  const [row] = await images.list(resolved);
  const started = await images.start(resolved, options.display ? { display: options.display } : {});
  // PLexus starts only an image no VM runs, so a projection recorded under
  // this name belonged to a VM that is gone.
  forgetProjection(projectRoot, resolved);
  const olderMcp = olderMcpWarning(row);
  const availability = projectionAvailability();
  const mountPath = resolveMountPath(projectRoot, readConfig(projectRoot), resolved);
  let projection;
  if (!availability.available) {
    projection = { reason: availability.reason };
  } else {
    try {
      projection = await startProjection(
        { name: resolved, images, endpoint: started.endpoint },
        mountPath,
        row.diskName,
      );
    } catch (error) {
      // Nothing says whether PIFS mounted, so stop the image rather than keep
      // a mount nothing records: its daemon unmounts once the image is gone.
      await images.stop(resolved).catch(() => {});
      throw error;
    }
  }
  if ("reason" in projection) {
    // The image and its tools are the point; the projection is the extra this
    // package bundles where the machine allows it.
    return {
      ...started,
      warning: [projectionUnavailableWarning(resolved, projection.reason), olderMcp]
        .filter(Boolean).join("\n"),
    };
  }
  recordProjection(projectRoot, resolved, { mountPath, projectionPort: projection.port, pifsRelease });
  return {
    ...started,
    mountPath,
    projectionPort: projection.port,
    ...(olderMcp ? { warning: olderMcp } : {}),
  };
}

/**
 * Stop one image, the default one when none is named, or with `all`, every
 * image of this project that a PLexus start left answering. A VM started by
 * hand, or by an older PLexus, has no endpoint, and only a stop that names
 * its image reaches it.
 *
 * @param {string} projectRoot
 * @param {string} [name]
 * @param {{ all?: boolean }} [options]
 */
export async function stopAgentImage(projectRoot, name, options = {}) {
  if (options.all && name !== undefined) {
    throw new Error("Stopping every image takes no image name.");
  }
  const images = projectImages(projectRoot);
  const rows = options.all
    ? (await images.list()).filter((row) => row.endpoint)
    : await images.list(resolveImageName(projectRoot, name));
  const projections = readProjections(projectRoot);
  const stopped = [];
  const warnings = [];
  for (const row of rows) {
    const projection = projections[row.name];
    if (projection && row.endpoint) {
      try {
        await callImageTool({ name: row.name, images, endpoint: row.endpoint }, "image_evaluate", {
          code: pifsStopCode(projection.projectionPort),
        });
      } catch (error) {
        // The stop goes on: the projection's daemon unmounts once its image
        // is gone, so a failed unmount leaves nothing behind for long.
        warnings.push(`PIFS did not unmount ${row.name}: ${error.message}`);
      }
    }
    stopped.push(await images.stop(row.name));
    forgetProjection(projectRoot, row.name);
  }
  return { stopped, ...(warnings.length > 0 ? { warning: warnings.join("\n") } : {}) };
}
