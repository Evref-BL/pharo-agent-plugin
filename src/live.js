import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  ScopedPharoLauncher,
  homeDependencyRepositoryCachePath,
  resolvePlexusHomePath,
  startProjectImage,
  stopProjectImage,
} from "@evref-bl/plexus";
import { callImageTool } from "./gateway.js";
import { readProjectConfig } from "./project.js";
import {
  readConfig,
  readRunningImages,
  recordedImageIsRunning,
  resolveImageId,
  resolveMountPath,
  selectRunningImage,
  smalltalkString,
  unappliedPharoMcpPin,
  writeRunningImages,
} from "./runtime.js";

export const pifsRelease = "v0.10.0";

// fuse-t ships as a macOS installer package, so it lands in /usr/local
// whatever Homebrew's prefix is. The unversioned symlink is what the daemon
// links against.
export const fuseLibraryPath = "/usr/local/lib/libfuse-t.dylib";

/**
 * Whether a source projection can be mounted here.
 *
 * PIFS needs macOS and fuse-t, which is a kernel-adjacent install the user
 * has to approve. PLexus and the Pharo MCP run anywhere, so until this was
 * checked, `image start` mounted unconditionally and then stopped the image
 * when the mount failed -- every image on Linux and Windows, and on any Mac
 * without fuse-t. The image and its tools were never the part that could not
 * work.
 *
 * @param {{ platform?: string, exists?: (path: string) => boolean }} [host]
 */
export function projectionAvailability(host = {}) {
  const platform = host.platform ?? process.platform;
  const exists = host.exists ?? fs.existsSync;
  if (platform !== "darwin") {
    return {
      available: false,
      reason: "A source projection needs macOS and fuse-t, which this platform"
        + ` (${platform}) cannot provide.`,
    };
  }
  if (!exists(fuseLibraryPath)) {
    return {
      available: false,
      reason: "A source projection needs fuse-t, which is not installed."
        + " Install it with `brew install --cask fuse-t`.",
    };
  }
  return { available: true };
}

export function projectionUnavailableWarning(imageId, reason) {
  return `${reason} Image ${imageId} is running with its Pharo tools and no`
    + " source projection; read and edit its code through the tools.";
}

// The class-side PIFSServer messages this plugin sends into the image. The
// release automation checks that a published PIFS still implements them: a pin
// bump that leaves a removed selector in place passes every test here, because
// the tests read generated source, and fails only in a live image.
export const pifsSelectors = ["startMountedAt:named:", "stopOn:"];

export function pifsStartCode(mountPath, imageName) {
  return `Metacello new
	baseline: 'PharoImageFS';
	repository: 'github://Evref-BL/pharo-image-fs:${pifsRelease}/src';
	load: 'Core'.
((Smalltalk globals at: #PIFSServer)
	startMountedAt: ${smalltalkString(mountPath)} asFileReference
	named: ${smalltalkString(imageName)}) port`;
}

export function pifsStopCode(projectionPort) {
  return `(Smalltalk globals at: #PIFSServer) stopOn: ${projectionPort}`;
}

// `mount` prints one "<source> on <path> (<options>)" line per mount, with the
// path resolved, so a project under a symlink is looked for by its real path.
export function isMountedAt(mountPath, mountTable) {
  let realPath = mountPath;
  try {
    realPath = path.join(fs.realpathSync(path.dirname(mountPath)), path.basename(mountPath));
  } catch {
    // No parent directory, so nothing can be mounted there either.
  }
  return mountTable
    .split("\n")
    .some((line) => line.includes(` on ${mountPath} (`) || line.includes(` on ${realPath} (`));
}

function currentMountTable() {
  return spawnSync("mount", [], { encoding: "utf8" }).stdout ?? "";
}

function unmount(mountPath) {
  // What PIFSServer>>stopDaemon runs when it stops a projection itself.
  if (spawnSync("umount", [mountPath], { stdio: "ignore" }).status !== 0) {
    spawnSync("diskutil", ["unmount", mountPath], { stdio: "ignore" });
  }
}

/**
 * Unmount a projection whose image is gone.
 *
 * The mount is served by a PIFS daemon, a process of its own that reads the
 * source over HTTP from the image. PIFS unmounts it from inside the image when
 * it stops, which an image that crashed or was closed never does: the mount
 * stays, every read in it fails with an I/O error, and it holds the path
 * against the next projection. Unmounting is enough; the daemon exits with its
 * mount.
 *
 * @param {string | undefined} mountPath
 * @param {{ mountTable?: () => string, unmount?: (path: string) => void }} [host]
 * @returns {boolean} whether something was unmounted
 */
export function releaseProjectionMount(mountPath, host = {}) {
  const mountTable = host.mountTable ?? currentMountTable;
  if (mountPath === undefined || !isMountedAt(mountPath, mountTable())) return false;
  (host.unmount ?? unmount)(mountPath);
  if (isMountedAt(mountPath, mountTable())) {
    throw new Error(
      `The source projection of an image that is gone is still mounted at ${mountPath},`
        + ` and could not be unmounted. Run umount ${JSON.stringify(mountPath)}, then try again.`,
    );
  }
  return true;
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
 * The status is spelled out rather than taken as a string: this read branched
 * for a long time on "declared" and "failed", which PLexus does not report,
 * so a declared image was never created and the launch that followed failed
 * on an image that was not there. Naming the four it does report makes the
 * typecheck reject a fifth.
 *
 * @param {{ images: { imageId: string,
 *   status: "absent" | "stopped" | "starting" | "running" }[] }} listed
 * @param {string} imageId
 */
export function imageCreationPlan(listed, imageId) {
  const summary = listed.images.find((image) => image.imageId === imageId);
  if (!summary) {
    throw new Error(`PLexus does not know image ${imageId}.`);
  }
  // "absent" is PLexus's word for no image file on disk, which is what a
  // declared image looks like until something creates it.
  if (summary.status === "absent") return "create";
  return "none";
}

export function describeLifecycleFailure(failure) {
  const stderr = failure.launcherResult?.raw?.stderr?.trim();
  return [
    `${failure.imageId}: ${failure.message}`,
    failure.diagnostic,
    failure.action,
    stderr ? `launcher: ${stderr.slice(0, 500)}` : undefined,
  ]
    .filter(Boolean)
    .join("\n  ");
}

// startProjectImage and stopProjectImage throw on failure, carrying the failures on the error.
export async function runLifecycle(action, fallback) {
  try {
    return await action();
  } catch (error) {
    const failures = error?.result?.failures;
    if (!Array.isArray(failures) || failures.length === 0) {
      throw error;
    }
    throw new Error(`${fallback}\n${failures.map(describeLifecycleFailure).join("\n")}`);
  }
}


export function pifsCloneDirectory(projectRoot) {
  const cache = homeDependencyRepositoryCachePath(
    resolvePlexusHomePath({ config: readProjectConfig(projectRoot) }),
  );
  return path.join(cache, "Evref-BL", "pharo-image-fs");
}

export function fetchPifsRelease(cloneDirectory, release = pifsRelease) {
  // The shared clone is reused as it was cloned, so a tag released later is
  // missing. Fetch here rather than in the image: the clone may have an ssh
  // remote, and only the host has the credentials for it.
  if (!fs.existsSync(cloneDirectory)) return false;
  const git = (...args) =>
    spawnSync("git", ["-C", cloneDirectory, ...args], { stdio: "ignore" }).status === 0;
  if (git("rev-parse", "--verify", `refs/tags/${release}`)) return false;
  return git("fetch", "--tags", "--quiet", "origin");
}

export async function startAgentImage(projectRoot, imageId) {
  const resolved = resolveImageId(projectRoot, imageId);
  let runningImages = readRunningImages(projectRoot);
  let restarted = false;
  if (runningImages[resolved]) {
    if (recordedImageIsRunning(runningImages[resolved])) {
      return { alreadyRunning: true, ...runningImages[resolved] };
    }
    // The image this record names has exited. Forget it and start again,
    // rather than hand back an endpoint nothing answers and call it running.
    const { [resolved]: exited, ...remaining } = runningImages;
    runningImages = remaining;
    writeRunningImages(projectRoot, runningImages);
    restarted = true;
  }
  if (projectionAvailability().available) {
    // This project has no live image at this mount path now: none was
    // recorded, or the one recorded has exited. Whatever is still mounted
    // there was left by an image that is gone, and would hold the path
    // against the projection about to be mounted.
    releaseProjectionMount(resolveMountPath(projectRoot, readConfig(projectRoot), resolved));
    fetchPifsRelease(pifsCloneDirectory(projectRoot));
  }
  const launcher = new ScopedPharoLauncher({ projectRoot });
  const plan = imageCreationPlan(await launcher.listImages(), resolved);
  const created = plan !== "none";
  if (created) {
    // PLexus resolves which category the template lives in.
    await launcher.createImage(resolved);
  }
  const started = await runLifecycle(
    () => startProjectImage({ projectRoot, imageId: resolved }),
    `PLexus could not start image ${resolved}.`,
  );
  let image;
  let mcpServerId;
  try {
    ({ image, mcpServerId } = selectRunningImage(started.state, resolved));
  } catch (error) {
    // An image whose Pharo version is outside the MCP contract still runs, and
    // is still worth having: the caller asked for that version, and the tools
    // it cannot offer are the only thing missing. Keep it, and say what is gone.
    const withoutMcp = unsupportedRunningImage(started.state, resolved);
    if (!withoutMcp) {
      // The image is running but unusable to us, so do not leave it behind.
      await stopProjectImage({ projectRoot, imageId: resolved }).catch(() => {});
      throw error;
    }
    const record = { statePath: started.statePath, imageId: resolved, mcp: false };
    writeRunningImages(projectRoot, { ...runningImages, [resolved]: record });
    return { ...record, created, warning: pharoMcpWarning(withoutMcp) };
  }
  const unappliedPin = unappliedPharoMcpPin(image);
  const projection = projectionAvailability();
  if (!projection.available) {
    // The image and its tools are the point; the projection is the extra this
    // package bundles where the platform allows it.
    const record = { statePath: started.statePath, imageId: image.id, mcpServerId };
    writeRunningImages(projectRoot, { ...runningImages, [resolved]: record });
    return {
      imageId: image.id,
      created,
      ...(restarted ? { restarted } : {}),
      warning: [
        projectionUnavailableWarning(image.id, projection.reason),
        unappliedPin,
      ].filter(Boolean).join("\n"),
    };
  }

  const mountPath = resolveMountPath(projectRoot, readConfig(projectRoot), image.id);
  fs.mkdirSync(path.dirname(mountPath), { recursive: true });
  const record = {
    statePath: started.statePath,
    imageId: image.id,
    mcpServerId,
    mountPath,
  };
  let projectionPort;
  try {
    projectionPort = await startProjection(projectRoot, record, image.imageName);
  } catch (error) {
    // The projection is half-started at best and nothing records it yet, so
    // stop the image rather than leave an image and a mount nothing owns.
    await stopProjectImage({ projectRoot, imageId: resolved }).catch(() => {});
    throw error;
  }
  writeRunningImages(projectRoot, { ...runningImages, [resolved]: { ...record, projectionPort } });
  return {
    imageId: image.id,
    created,
    ...(restarted ? { restarted } : {}),
    mountPath,
    projectionPort,
    ...(unappliedPin ? { warning: unappliedPin } : {}),
  };
}

function unsupportedRunningImage(state, imageId) {
  const image = (state.images ?? []).find(
    (candidate) => candidate.id === imageId && candidate.status === "running",
  );
  return image?.pharoMcpContract?.status === "unsupported" ? image : undefined;
}

export function pharoMcpWarning(image) {
  const reason = image.pharoMcpContract?.reason
    ?? "This image Pharo version is outside the supported Pharo MCP range.";
  return `${reason} Image ${image.id} is running without MCP tools or a source projection;`
    + " drive it with the Pharo command line instead.";
}

async function startProjection(projectRoot, record, imageName) {
  const result = await callImageTool(projectRoot, record, "image_evaluate", {
    code: pifsStartCode(record.mountPath, imageName),
  });
  const projectionPort = Number(resultPrintString(result));
  if (!Number.isInteger(projectionPort) || projectionPort < 1) {
    throw new Error(
      `PIFS did not report a projection port: ${JSON.stringify(result).slice(0, 500)}`,
    );
  }
  return projectionPort;
}

async function stopOneImage(projectRoot, runningImages, imageId) {
  const record = runningImages[imageId];
  let projectionError;
  // An image started without MCP has no projection to stop, and no route to
  // ask over either.
  if (record.projectionPort !== undefined) {
    try {
      if (recordedImageIsRunning(record)) {
        await callImageTool(projectRoot, record, "image_evaluate", {
          code: pifsStopCode(record.projectionPort),
        });
      } else {
        // PIFS stops a projection from inside its image, and this one is gone.
        releaseProjectionMount(record.mountPath);
      }
    } catch (error) {
      projectionError = error;
    }
  }
  const stopped = await runLifecycle(
    () => stopProjectImage({ projectRoot, imageId }),
    `PLexus could not stop image ${imageId}.`,
  );
  return { stoppedImage: stopped.stoppedImage?.id, projectionError };
}

/**
 * Stop one image, or with `all`, every image this project started. Naming no
 * image stops the default one, as every other command addresses it; `all` is
 * the cleanup, and says so where the caller can see it.
 *
 * @param {string} projectRoot
 * @param {string} [imageId]
 * @param {{ all?: boolean }} [options]
 */
export async function stopAgentImage(projectRoot, imageId, options = {}) {
  const runningImages = readRunningImages(projectRoot);
  if (options.all && imageId !== undefined) {
    throw new Error("Stopping every image takes no image id.");
  }
  const identifiers = options.all
    ? Object.keys(runningImages)
    : [resolveImageId(projectRoot, imageId)];
  if (identifiers.length === 0) {
    throw new Error("No pharo-agent image is running.");
  }
  for (const identifier of identifiers) {
    if (!runningImages[identifier]) {
      throw new Error(`Image ${identifier} is not running.`);
    }
  }

  const stoppedImages = [];
  const projectionErrors = [];
  const remaining = { ...runningImages };
  for (const identifier of identifiers) {
    const stopped = await stopOneImage(projectRoot, runningImages, identifier);
    delete remaining[identifier];
    writeRunningImages(projectRoot, remaining);
    if (stopped.stoppedImage) {
      stoppedImages.push(stopped.stoppedImage);
    }
    if (stopped.projectionError) {
      projectionErrors.push(`${identifier}: ${stopped.projectionError.message}`);
    }
  }
  if (projectionErrors.length > 0) {
    throw new Error(`Images stopped, but PIFS cleanup failed: ${projectionErrors.join("; ")}`);
  }
  return { stoppedImages };
}

export async function listImageTemplates(projectRoot) {
  // `image add --template` takes a name the launcher must already know, and a
  // name that lands in two categories needs the category as well, so answer
  // both rather than leave the caller guessing a magic string. Listing without
  // a category walks the groups and stamps `templateCategory` on each row, and
  // neither it nor the launcher's own `category` is promised when the sources
  // list names no group at all, which is why both are optional.
  const listed = await new ScopedPharoLauncher({ projectRoot }).listTemplates();
  const counts = new Map();
  for (const template of listed.templates) {
    counts.set(template.name, (counts.get(template.name) ?? 0) + 1);
  }
  return {
    templates: listed.templates.map((template) => ({
      name: template.name,
      category: template.templateCategory,
      ...(counts.get(template.name) > 1 ? { categoryRequired: true } : {}),
    })),
  };
}
