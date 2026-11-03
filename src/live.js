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
import { readProjectConfig, writeProjectConfig } from "./project.js";
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

export const pifsRelease = "v0.9.2";

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

// The launcher resolves a template name against its default group only, so an
// image naming a template from any other group cannot be created until the
// project config says which group that is. Find it once, on first creation.
export async function resolveTemplateCategory(projectRoot, launcher, imageId) {
  const config = readProjectConfig(projectRoot);
  const images = Array.isArray(config.images) ? config.images : [];
  const configured = images.find((image) => image.id === imageId);
  const create = configured?.create;
  if (!create?.templateName || create.templateCategory) {
    return create?.templateCategory;
  }

  const listed = await launcher.listTemplates();
  const templates = Array.isArray(listed?.templates) ? listed.templates : [];
  const categories = [
    ...new Set(
      templates
        .filter((template) => template?.name === create.templateName)
        .map((template) => template?.templateCategory)
        .filter(Boolean),
    ),
  ];
  if (categories.length === 0) {
    throw new Error(`No template named ${create.templateName} in any category.`);
  }
  if (categories.length > 1) {
    throw new Error(
      `Template ${create.templateName} exists in several categories: ${categories.join(", ")}.`
      + ` Set create.templateCategory for image ${imageId} to choose one.`,
    );
  }

  const [templateCategory] = categories;
  writeProjectConfig(projectRoot, {
    ...config,
    images: images.map((image) => (image.id === imageId
      ? { ...image, create: { ...image.create, templateCategory } }
      : image)),
  });
  return templateCategory;
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
  fetchPifsRelease(pifsCloneDirectory(projectRoot));
  const launcher = new ScopedPharoLauncher({ projectRoot });
  const plan = imageCreationPlan(await launcher.listImages(), resolved);
  const created = plan !== "none";
  if (created) {
    await resolveTemplateCategory(projectRoot, launcher, resolved);
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
  const unappliedPin = unappliedPharoMcpPin(image);
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
      await callImageTool(projectRoot, record, "image_evaluate", {
        code: pifsStopCode(record.projectionPort),
      });
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
