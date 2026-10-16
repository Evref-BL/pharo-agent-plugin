import fs from "node:fs";
import path from "node:path";
import { closeProject, openProject } from "@evref-bl/plexus";
import { callActiveTool } from "./gateway.js";
import { configuredActiveImageId } from "./project.js";
import {
  activePath,
  clearActive,
  readActive,
  readConfig,
  resolveMountPath,
  selectRunningImage,
  smalltalkString,
  writeActive,
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

export async function openAgentImage(projectRoot) {
  if (fs.existsSync(activePath(projectRoot))) {
    return { alreadyOpen: true, ...readActive(projectRoot) };
  }
  const configuredImageId = configuredActiveImageId(projectRoot);
  const opened = await openProject({ projectRoot, imageIds: [configuredImageId] });
  if (!opened.ok || opened.failures.length > 0) {
    throw new Error(opened.failures.map((failure) => failure.message).join("\n") || "PLexus could not open the project image.");
  }
  const { image, mcpServerId } = selectRunningImage(opened.state, configuredImageId);
  const mountPath = resolveMountPath(projectRoot, readConfig(projectRoot), image.id);
  fs.mkdirSync(path.dirname(mountPath), { recursive: true });
  const active = {
    statePath: opened.statePath,
    imageId: image.id,
    mcpServerId,
    mountPath,
  };
  const result = await callActiveTool(projectRoot, active, "image_evaluate", {
    code: pifsStartCode(mountPath, image.imageName),
  });
  const port = Number(resultPrintString(result));
  if (!Number.isInteger(port) || port < 1) {
    throw new Error("PIFS started but did not report its projection port.");
  }
  writeActive(projectRoot, { ...active, projectionPort: port });
  return { imageId: image.id, mountPath, projectionPort: port };
}

export async function closeAgentImage(projectRoot) {
  const active = readActive(projectRoot);
  let projectionError;
  try {
    await callActiveTool(projectRoot, active, "image_evaluate", {
      code: `PIFSServer stopOn: ${active.projectionPort}`,
    });
  } catch (error) {
    projectionError = error;
  }
  const closed = await closeProject({ projectRoot, imageIds: [active.imageId] });
  if (!closed.ok || closed.failures.length > 0) {
    throw new Error(closed.failures.map((failure) => failure.message).join("\n") || "PLexus could not close the project image.");
  }
  clearActive(projectRoot);
  if (projectionError) {
    throw new Error(`Image closed, but PIFS cleanup failed: ${projectionError.message}`);
  }
  return { stoppedImages: closed.stoppedImages.map((image) => image.id) };
}
