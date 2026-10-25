import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  ScopedPharoLauncher,
  closeProject,
  homeDependencyRepositoryCachePath,
  openProject,
  resolvePlexusHomePath,
} from "@evref-bl/plexus";
import { callImageTool } from "./gateway.js";
import { readProjectConfig, writeProjectConfig } from "./project.js";
import {
  defaultImageId,
  readConfig,
  readOpenImages,
  resolveImageId,
  resolveMountPath,
  selectRunningImage,
  smalltalkString,
  unappliedPharoMcpPin,
  writeOpenImages,
} from "./runtime.js";

export const pifsRelease = "v0.6.1";

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

export function imageCreationPlan(listed, imageId) {
  const summary = listed.images.find((image) => image.imageId === imageId);
  if (!summary) {
    throw new Error(`PLexus does not know image ${imageId}.`);
  }
  // PLexus reports an image it has no runtime state for as declared.
  if (summary.status === "declared") return "create";
  // A creation that failed leaves runtime state that blocks both a retry and a
  // fresh declaration of the same id, so the id would be spent for good. Clear
  // it and create again.
  if (summary.status === "failed") return "reset";
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

// openProject and closeProject throw on failure, carrying the failures on the error.
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

export async function openAgentImage(projectRoot, imageId) {
  const resolved = resolveImageId(projectRoot, imageId);
  const openImages = readOpenImages(projectRoot);
  if (openImages[resolved]) {
    return { alreadyOpen: true, ...openImages[resolved] };
  }
  fetchPifsRelease(pifsCloneDirectory(projectRoot));
  const launcher = new ScopedPharoLauncher({ projectRoot });
  const plan = imageCreationPlan(launcher.listImages(), resolved);
  const created = plan !== "none";
  if (created) {
    if (plan === "reset") await launcher.resetImage(resolved);
    await resolveTemplateCategory(projectRoot, launcher, resolved);
    await launcher.createImage(resolved);
  }
  const opened = await runLifecycle(
    () => openProject({ projectRoot, imageIds: [resolved] }),
    `PLexus could not open image ${resolved}.`,
  );
  let image;
  let mcpServerId;
  try {
    ({ image, mcpServerId } = selectRunningImage(opened.state, resolved));
  } catch (error) {
    // An image whose Pharo version is outside the MCP contract still runs, and
    // is still worth having: the caller asked for that version, and the tools
    // it cannot offer are the only thing missing. Keep it, and say what is gone.
    const withoutMcp = unsupportedRunningImage(opened.state, resolved);
    if (!withoutMcp) {
      // The image is running but unusable to us, so do not leave it behind.
      await closeProject({ projectRoot, imageIds: [resolved] }).catch(() => {});
      throw error;
    }
    const open = { statePath: opened.statePath, imageId: resolved, mcp: false };
    writeOpenImages(projectRoot, { ...openImages, [resolved]: open });
    return { ...open, created, warning: pharoMcpWarning(withoutMcp) };
  }
  const mountPath = resolveMountPath(projectRoot, readConfig(projectRoot), image.id);
  fs.mkdirSync(path.dirname(mountPath), { recursive: true });
  const open = {
    statePath: opened.statePath,
    imageId: image.id,
    mcpServerId,
    mountPath,
  };
  let projectionPort;
  try {
    projectionPort = await startProjection(projectRoot, open, image.imageName);
  } catch (error) {
    // The projection is half-started at best and nothing records it yet, so
    // close the image rather than leave an image and a mount nothing owns.
    await closeProject({ projectRoot, imageIds: [resolved] }).catch(() => {});
    throw error;
  }
  writeOpenImages(projectRoot, { ...openImages, [resolved]: { ...open, projectionPort } });
  const unappliedPin = unappliedPharoMcpPin(image);
  return {
    imageId: image.id,
    created,
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
  return `${reason} Image ${image.id} is open without MCP tools or a source projection;`
    + " drive it with the Pharo command line instead.";
}

async function startProjection(projectRoot, open, imageName) {
  const result = await callImageTool(projectRoot, open, "image_evaluate", {
    code: pifsStartCode(open.mountPath, imageName),
  });
  const projectionPort = Number(resultPrintString(result));
  if (!Number.isInteger(projectionPort) || projectionPort < 1) {
    throw new Error(
      `PIFS did not report a projection port: ${JSON.stringify(result).slice(0, 500)}`,
    );
  }
  return projectionPort;
}

async function closeOneImage(projectRoot, openImages, imageId) {
  const open = openImages[imageId];
  let projectionError;
  // An image opened without MCP has no projection to stop, and no route to
  // ask over either.
  if (open.projectionPort !== undefined) {
    try {
      await callImageTool(projectRoot, open, "image_evaluate", {
        code: pifsStopCode(open.projectionPort),
      });
    } catch (error) {
      projectionError = error;
    }
  }
  const closed = await runLifecycle(
    () => closeProject({ projectRoot, imageIds: [imageId] }),
    `PLexus could not close image ${imageId}.`,
  );
  return { stoppedImages: closed.stoppedImages.map((image) => image.id), projectionError };
}

export async function closeAgentImage(projectRoot, imageId) {
  const openImages = readOpenImages(projectRoot);
  const identifiers = imageId === undefined
    ? Object.keys(openImages)
    : [resolveImageId(projectRoot, imageId)];
  if (identifiers.length === 0) {
    throw new Error("No open pharo-agent image.");
  }
  for (const identifier of identifiers) {
    if (!openImages[identifier]) {
      throw new Error(`Image ${identifier} is not open.`);
    }
  }

  const stoppedImages = [];
  const projectionErrors = [];
  const remaining = { ...openImages };
  for (const identifier of identifiers) {
    const closed = await closeOneImage(projectRoot, openImages, identifier);
    delete remaining[identifier];
    writeOpenImages(projectRoot, remaining);
    stoppedImages.push(...closed.stoppedImages);
    if (closed.projectionError) {
      projectionErrors.push(`${identifier}: ${closed.projectionError.message}`);
    }
  }
  if (projectionErrors.length > 0) {
    throw new Error(`Images closed, but PIFS cleanup failed: ${projectionErrors.join("; ")}`);
  }
  return { stoppedImages };
}

export function agentImageStatus(projectRoot) {
  const openImages = readOpenImages(projectRoot);
  let defaultImage;
  try {
    defaultImage = defaultImageId(projectRoot);
  } catch {
    defaultImage = undefined;
  }
  return {
    ...(defaultImage ? { defaultImage } : {}),
    images: Object.values(openImages).map((open) => ({
      ...open,
      isDefault: open.imageId === defaultImage,
    })),
  };
}

export async function listImageTemplates(projectRoot) {
  // `image add --template` takes a name the launcher must already know, and a
  // name that lands in two categories needs the category as well, so answer
  // both rather than leave the caller guessing a magic string.
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
