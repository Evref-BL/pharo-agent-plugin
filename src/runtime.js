import fs from "node:fs";
import path from "node:path";
import { configuredImages, pluginDirectory } from "./project.js";

export function runtimeDirectory(projectRoot) {
  return path.join(pluginDirectory(projectRoot), "runtime");
}

export function activePath(projectRoot) {
  return path.join(runtimeDirectory(projectRoot), "active.json");
}

export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${filePath}: ${error.message}`);
  }
}

export function configPath(projectRoot) {
  return path.join(pluginDirectory(projectRoot), "config.json");
}

export function readConfig(projectRoot) {
  return readJson(configPath(projectRoot));
}

export function writeConfig(projectRoot, config) {
  fs.writeFileSync(configPath(projectRoot), `${JSON.stringify(config, null, 2)}\n`);
}

export function readOpenImages(projectRoot) {
  const filePath = activePath(projectRoot);
  if (!fs.existsSync(filePath)) return {};
  const recorded = readJson(filePath);
  if (recorded && typeof recorded.images === "object" && recorded.images !== null) {
    return recorded.images;
  }
  return typeof recorded?.imageId === "string" ? { [recorded.imageId]: recorded } : {};
}

export function writeOpenImages(projectRoot, images) {
  if (Object.keys(images).length === 0) {
    fs.rmSync(activePath(projectRoot), { force: true });
    return;
  }
  fs.mkdirSync(runtimeDirectory(projectRoot), { recursive: true });
  fs.writeFileSync(activePath(projectRoot), `${JSON.stringify({ images }, null, 2)}\n`);
}

export function defaultImageId(projectRoot) {
  const configured = readConfig(projectRoot).defaultImage;
  const images = configuredImages(projectRoot);
  if (typeof configured === "string") {
    if (!images.some((image) => image.id === configured)) {
      throw new Error(
        `The default image ${configured} is not configured. Run pharo-agent image use <id>.`,
      );
    }
    return configured;
  }
  if (images.length === 1 && typeof images[0].id === "string") {
    return images[0].id;
  }
  if (images.length === 0) {
    throw new Error(
      "No image is configured. Register one with pharo-agent image add <id> --template <name>.",
    );
  }
  throw new Error(
    `Several images are configured (${images.map((image) => image.id).join(", ")}); `
      + "choose one with pharo-agent image use <id>, or pass --image <id>.",
  );
}

export function resolveImageId(projectRoot, imageId) {
  if (imageId === undefined) return defaultImageId(projectRoot);
  if (!configuredImages(projectRoot).some((image) => image.id === imageId)) {
    throw new Error(`Image ${imageId} is not configured.`);
  }
  return imageId;
}

export function readOpenImage(projectRoot, imageId) {
  const resolved = resolveImageId(projectRoot, imageId);
  const open = readOpenImages(projectRoot)[resolved];
  if (!open) {
    throw new Error(
      `Image ${resolved} is not open. Run pharo-agent open${imageId ? ` --image ${resolved}` : ""} first.`,
    );
  }
  return open;
}

export function resolveMountPath(projectRoot, config, imageId) {
  const root = config.mountRoot ?? ".pharo-agent/mounts";
  return path.resolve(projectRoot, root, imageId);
}

export function selectRunningImage(state, imageId) {
  const running = (state.images ?? []).filter((image) => image.status === "running");
  const images = imageId === undefined
    ? running
    : running.filter((image) => image.id === imageId);
  if (images.length !== 1) {
    throw new Error(
      imageId === undefined
        ? `pharo-agent needs exactly one running image; PLexus reported ${images.length}.`
        : `PLexus reports ${images.length} running images with id ${imageId}.`,
    );
  }
  const image = images[0];
  if (!Array.isArray(image.mcpServers) || image.mcpServers.length !== 1) {
    // PLexus withholds the route when the image is outside the MCP contract,
    // and records why. Say that rather than only the endpoint count.
    const contract = image.pharoMcpContract;
    const reason = contract?.status === "unsupported" && contract.reason
      ? ` ${contract.reason}`
      : "";
    throw new Error(
      `Image ${image.id} needs exactly one MCP endpoint; PLexus reported ${image.mcpServers?.length ?? 0}.${reason}`,
    );
  }
  return { image, mcpServerId: image.mcpServers[0].id };
}

export function smalltalkString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
