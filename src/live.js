import fs from "node:fs";
import path from "node:path";
import { ScopedPharoLauncher, closeProject, openProject } from "@evref-bl/plexus";
import { callImageTool } from "./gateway.js";
import {
  defaultImageId,
  readConfig,
  readOpenImages,
  resolveImageId,
  resolveMountPath,
  selectRunningImage,
  smalltalkString,
  writeOpenImages,
} from "./runtime.js";

export const pifsRelease = "v0.4.1";

export function pifsStartCode(mountPath, imageName) {
  return `"A shared Iceberg clone is never refetched, so a tag released after it was cloned cannot resolve."
IceRepository registry
	detect: [ :each | each name = 'pharo-image-fs' ]
	ifFound: [ :repository |
		(repository tags anySatisfy: [ :tag | tag name = '${pifsRelease}' ])
			ifFalse: [ [ repository fetch ] on: Error do: [ :error | "the load below reports the real failure" ] ] ].
Metacello new
	baseline: 'PharoImageFS';
	repository: 'github://Evref-BL/pharo-image-fs:${pifsRelease}/src';
	load: 'Core'.
((Smalltalk globals at: #PIFSServer)
	startOn: 0
	mountAt: ${smalltalkString(mountPath)} asFileReference
	named: ${smalltalkString(imageName)}) port`;
}

export function resultPrintString(result) {
  // MCP tool results carry the image's answer as JSON inside a text content part.
  if (typeof result === "string") {
    try {
      return resultPrintString(JSON.parse(result));
    } catch {
      return undefined;
    }
  }
  if (!result || typeof result !== "object") return undefined;
  if (typeof result.resultPrintString === "string") return result.resultPrintString;
  for (const value of Object.values(result)) {
    const found = resultPrintString(value);
    if (found) return found;
  }
  return undefined;
}


export function needsImageCreation(listed, imageId) {
  const summary = listed.images.find((image) => image.imageId === imageId);
  if (!summary) {
    throw new Error(`PLexus does not know image ${imageId}.`);
  }
  // PLexus reports an image it has no runtime state for as declared.
  return summary.status === "declared";
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

export async function openAgentImage(projectRoot, imageId) {
  const resolved = resolveImageId(projectRoot, imageId);
  const openImages = readOpenImages(projectRoot);
  if (openImages[resolved]) {
    return { alreadyOpen: true, ...openImages[resolved] };
  }
  const launcher = new ScopedPharoLauncher({ projectRoot });
  const created = needsImageCreation(launcher.listImages(), resolved);
  if (created) {
    await launcher.createImage(resolved);
  }
  const opened = await runLifecycle(
    () => openProject({ projectRoot, imageIds: [resolved] }),
    `PLexus could not open image ${resolved}.`,
  );
  const { image, mcpServerId } = selectRunningImage(opened.state, resolved);
  const mountPath = resolveMountPath(projectRoot, readConfig(projectRoot), image.id);
  fs.mkdirSync(path.dirname(mountPath), { recursive: true });
  const open = {
    statePath: opened.statePath,
    imageId: image.id,
    mcpServerId,
    mountPath,
  };
  const result = await callImageTool(projectRoot, open, "image_evaluate", {
    code: pifsStartCode(mountPath, image.imageName),
  });
  const projectionPort = Number(resultPrintString(result));
  if (!Number.isInteger(projectionPort) || projectionPort < 1) {
    throw new Error(
      `PIFS did not report a projection port: ${JSON.stringify(result).slice(0, 500)}`,
    );
  }
  writeOpenImages(projectRoot, { ...openImages, [resolved]: { ...open, projectionPort } });
  return { imageId: image.id, created, mountPath, projectionPort };
}

async function closeOneImage(projectRoot, openImages, imageId) {
  const open = openImages[imageId];
  let projectionError;
  try {
    await callImageTool(projectRoot, open, "image_evaluate", {
      code: `(Smalltalk globals at: #PIFSServer) stopOn: ${open.projectionPort}`,
    });
  } catch (error) {
    projectionError = error;
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
