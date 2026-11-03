import {
  configuredImages,
  projectIdentity,
  readProjectConfig,
  writeProjectConfig,
} from "./project.js";
import { defaultImageId, readConfig, readRunningImages, writeConfig } from "./runtime.js";

export const defaultLoadScript = "pharo/load-mcp.st";

function assertNotRunning(projectRoot, imageId, action) {
  if (readRunningImages(projectRoot)[imageId]) {
    throw new Error(
      `Image ${imageId} is running. Run pharo-agent image stop ${imageId} before ${action}.`,
    );
  }
}

function derivedImageName(projectRoot, imageId) {
  const { name } = projectIdentity(projectRoot);
  return `${name}-{workspaceId}-${imageId}`;
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
      // The record repeats the id it is keyed by; everything else in it is
      // runtime detail this list carries when the image is running.
      const { imageId: _keyed, ...runtime } = running[image.id] ?? {};
      return {
        id: image.id,
        imageName: image.imageName,
        isDefault: image.id === defaultImage,
        running: Boolean(running[image.id]),
        ...runtime,
        templateName: image.create?.templateName,
        templateCategory: image.create?.templateCategory,
      };
    }),
  };
}

/** @param {{ id: string, template?: string, category?: string, profile?: string }} request */
export function addImage(projectRoot, request) {
  const { id, template, category, profile } = request;
  const config = readProjectConfig(projectRoot);
  const images = Array.isArray(config.images) ? config.images : [];
  if (images.some((image) => image.id === id)) {
    throw new Error(`Image ${id} is already configured.`);
  }
  const imageName = derivedImageName(projectRoot, id);
  if (images.some((image) => image.imageName === imageName)) {
    throw new Error(`Image name ${imageName} is already configured.`);
  }

  const image = {
    id,
    imageName,
    active: true,
    mcp: { loadScript: defaultLoadScript, loadPolicy: "ifMissing" },
    create: {
      kind: "template",
      ...(profile ? { profileId: profile } : {}),
      templateName: template,
      ...(category ? { templateCategory: category } : {}),
      cleanupPolicy: "workspace_cleanup_only",
    },
  };
  writeProjectConfig(projectRoot, { ...config, images: [...images, image] });
  const pluginConfig = readConfig(projectRoot);
  const isDefault = pluginConfig.defaultImage === undefined && images.length === 0;
  if (isDefault) {
    writeConfig(projectRoot, { ...pluginConfig, defaultImage: id });
  }
  return {
    id,
    imageName,
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
  const config = readProjectConfig(projectRoot);
  const images = Array.isArray(config.images) ? config.images : [];
  if (!images.some((image) => image.id === id)) {
    throw new Error(`Image ${id} is not configured.`);
  }
  assertNotRunning(projectRoot, id, "removing it");
  writeProjectConfig(projectRoot, {
    ...config,
    images: images.filter((image) => image.id !== id),
  });
  const pluginConfig = readConfig(projectRoot);
  if (pluginConfig.defaultImage === id) {
    const { defaultImage: _removed, ...rest } = pluginConfig;
    writeConfig(projectRoot, rest);
  }
  return { removedImageId: id };
}
