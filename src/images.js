import { declareProjectImage, removeProjectImage } from "@evref-bl/plexus";
import { configuredImages } from "./project.js";
import {
  defaultImageId,
  readConfig,
  readRunningImages,
  recordedImageIsRunning,
  writeConfig,
} from "./runtime.js";

export const defaultLoadScript = "pharo/load-mcp.st";

function assertNotRunning(projectRoot, imageId, action) {
  if (readRunningImages(projectRoot)[imageId]) {
    throw new Error(
      `Image ${imageId} is running. Run pharo-agent image stop ${imageId} before ${action}.`,
    );
  }
}

export function listImages(projectRoot) {
  const configured = configuredImages(projectRoot);
  const running = readRunningImages(projectRoot);
  let defaultImage;
  try {
    defaultImage = defaultImageId(projectRoot);
  } catch {
    // Several declared and none chosen. The list is how a caller finds that
    // out, so it answers rather than raising the question back at them.
    defaultImage = undefined;
  }
  return {
    ...(defaultImage ? { defaultImage } : {}),
    images: configured.map((image) => {
      const record = running[image.id];
      // A record says this project started the image, not that it is still
      // there. One that crashed or was closed keeps its record until it is
      // started or stopped again, and its route and mount lead nowhere.
      const alive = record !== undefined && recordedImageIsRunning(record);
      // The record repeats the id it is keyed by; everything else in it is
      // runtime detail this list carries when the image is running.
      const { imageId: _keyed, ...runtime } = alive ? record : {};
      return {
        id: image.id,
        imageName: image.imageName,
        isDefault: image.id === defaultImage,
        running: alive,
        ...(record !== undefined && !alive ? { exited: true } : {}),
        ...runtime,
        templateName: image.create?.templateName,
        templateCategory: image.create?.templateCategory,
      };
    }),
  };
}

/**
 * PLexus owns `plexus.json`, so PLexus writes it. This package chooses what
 * to declare — the load script that puts the pinned MCP in the image — and
 * leaves the schema, the name template, the defaults and the validation to
 * the package that reads them back.
 *
 * @param {{ id: string, template: string, category?: string, profile?: string }} request
 */
export function addImage(projectRoot, request) {
  const { id, template, category, profile } = request;
  const declaredBefore = configuredImages(projectRoot).length;
  const config = declareProjectImage(projectRoot, {
    id,
    templateName: template,
    ...(category ? { templateCategory: category } : {}),
    ...(profile ? { profileId: profile } : {}),
    loadScript: defaultLoadScript,
  });
  const declared = config.images.find((image) => image.id === id);
  if (!declared) {
    throw new Error(`PLexus declared image ${id} but did not record it.`);
  }

  const pluginConfig = readConfig(projectRoot);
  const isDefault = pluginConfig.defaultImage === undefined && declaredBefore === 0;
  if (isDefault) {
    writeConfig(projectRoot, { ...pluginConfig, defaultImage: id });
  }
  return {
    id,
    imageName: declared.imageName,
    isDefault,
    templateName: template,
    ...(category ? { templateCategory: category } : {}),
  };
}

export function useImage(projectRoot, id) {
  if (!configuredImages(projectRoot).some((image) => image.id === id)) {
    throw new Error(`Image ${id} is not configured.`);
  }
  writeConfig(projectRoot, { ...readConfig(projectRoot), defaultImage: id });
  return { defaultImage: id };
}

export function removeImage(projectRoot, id) {
  if (!configuredImages(projectRoot).some((image) => image.id === id)) {
    throw new Error(`Image ${id} is not configured.`);
  }
  assertNotRunning(projectRoot, id, "removing it");
  removeProjectImage(projectRoot, id);
  const pluginConfig = readConfig(projectRoot);
  if (pluginConfig.defaultImage === id) {
    const { defaultImage: _removed, ...rest } = pluginConfig;
    writeConfig(projectRoot, rest);
  }
  return { removedImageId: id };
}
