import fs from "node:fs";
import path from "node:path";
import { closeProject, openProject } from "@evref-bl/plexus";
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

export const pifsRelease = "v0.4.0";

export function pifsStartCode(mountPath, imageName) {
  return `Metacello new
	baseline: 'PharoImageFS';
	repository: 'github://Evref-BL/pharo-image-fs:${pifsRelease}/src';
	load: 'Core'.
(PIFSServer
	startOn: 0
	mountAt: ${smalltalkString(mountPath)} asFileReference
	named: ${smalltalkString(imageName)}) port`;
}

export function resultPrintString(result) {
  if (!result || typeof result !== "object") return undefined;
  if (typeof result.resultPrintString === "string") return result.resultPrintString;
  for (const value of Object.values(result)) {
    const found = resultPrintString(value);
    if (found) return found;
  }
  return undefined;
}

export async function openAgentImage(projectRoot, imageId) {
  const resolved = resolveImageId(projectRoot, imageId);
  const openImages = readOpenImages(projectRoot);
  if (openImages[resolved]) {
    return { alreadyOpen: true, ...openImages[resolved] };
  }
  const opened = await openProject({ projectRoot, imageIds: [resolved] });
  if (!opened.ok || opened.failures.length > 0) {
    throw new Error(opened.failures.map((failure) => failure.message).join("\n") || "PLexus could not open the project image.");
  }
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
    throw new Error("PIFS started but did not report its projection port.");
  }
  writeOpenImages(projectRoot, { ...openImages, [resolved]: { ...open, projectionPort } });
  return { imageId: image.id, mountPath, projectionPort };
}

async function closeOneImage(projectRoot, openImages, imageId) {
  const open = openImages[imageId];
  let projectionError;
  try {
    await callImageTool(projectRoot, open, "image_evaluate", {
      code: `PIFSServer stopOn: ${open.projectionPort}`,
    });
  } catch (error) {
    projectionError = error;
  }
  const closed = await closeProject({ projectRoot, imageIds: [imageId] });
  if (!closed.ok || closed.failures.length > 0) {
    throw new Error(closed.failures.map((failure) => failure.message).join("\n") || "PLexus could not close the project image.");
  }
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
