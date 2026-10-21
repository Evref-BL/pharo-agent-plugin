import {
  configuredImages,
  projectIdentity,
  readProjectConfig,
  writeProjectConfig,
} from "./project.js";
import { readConfig, readOpenImages, writeConfig } from "./runtime.js";

export const defaultLoadScript = "pharo/load-mcp.st";

function assertNoOpenImage(projectRoot, imageId, action) {
  if (readOpenImages(projectRoot)[imageId]) {
    throw new Error(`Image ${imageId} is open. Run pharo-agent close before ${action}.`);
  }
}

function derivedImageName(projectRoot, imageId) {
  const { name } = projectIdentity(projectRoot);
  return `${name}-{workspaceId}-${imageId}`;
}

export function listImages(projectRoot) {
  const configured = configuredImages(projectRoot);
  const open = readOpenImages(projectRoot);
  const defaultImage = readConfig(projectRoot).defaultImage
    ?? (configured.length === 1 ? configured[0].id : undefined);
  return {
    ...(defaultImage ? { defaultImage } : {}),
    images: configured.map((image) => ({
      id: image.id,
      imageName: image.imageName,
      isDefault: image.id === defaultImage,
      open: Boolean(open[image.id]),
      templateName: image.create?.templateName,
      templateCategory: image.create?.templateCategory,
    })),
  };
}

export function addImage(projectRoot, { id, template, profile }) {
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
      cleanupPolicy: "workspace_cleanup_only",
    },
  };
  writeProjectConfig(projectRoot, { ...config, images: [...images, image] });
  const pluginConfig = readConfig(projectRoot);
  const isDefault = pluginConfig.defaultImage === undefined && images.length === 0;
  if (isDefault) {
    writeConfig(projectRoot, { ...pluginConfig, defaultImage: id });
  }
  return { id, imageName, isDefault, templateName: template };
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
  assertNoOpenImage(projectRoot, id, "removing it");
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
