import fs from "node:fs";
import {
  configuredImages,
  projectIdentity,
  readProjectConfig,
  writeProjectConfig,
} from "./project.js";
import { activePath, readActive } from "./runtime.js";

export const defaultLoadScript = "pharo/load-mcp.st";

function assertNoOpenImage(projectRoot, imageId, action) {
  if (!fs.existsSync(activePath(projectRoot))) return;
  const active = readActive(projectRoot);
  if (active.imageId === imageId) {
    throw new Error(`Image ${imageId} is open. Run pharo-agent close before ${action}.`);
  }
}

function derivedImageName(projectRoot, imageId) {
  const { name } = projectIdentity(projectRoot);
  return `${name}-{workspaceId}-${imageId}`;
}

export function listImages(projectRoot) {
  return {
    images: configuredImages(projectRoot).map((image) => ({
      id: image.id,
      imageName: image.imageName,
      active: image.active === true,
      templateName: image.create?.templateName,
      templateCategory: image.create?.templateCategory,
    })),
  };
}

export function addImage(projectRoot, { id, template, category, profile }) {
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
    active: !images.some((other) => other.active === true),
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
  return { id, imageName, active: image.active, templateName: template };
}

export function useImage(projectRoot, id) {
  const config = readProjectConfig(projectRoot);
  const images = Array.isArray(config.images) ? config.images : [];
  if (!images.some((image) => image.id === id)) {
    throw new Error(`Image ${id} is not configured.`);
  }
  for (const image of images) {
    if (image.active === true && image.id !== id) {
      assertNoOpenImage(projectRoot, image.id, "switching the active image");
    }
  }
  writeProjectConfig(projectRoot, {
    ...config,
    images: images.map((image) => ({ ...image, active: image.id === id })),
  });
  return { activeImageId: id };
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
  return { removedImageId: id };
}
