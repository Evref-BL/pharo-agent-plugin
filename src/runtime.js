import fs from "node:fs";
import path from "node:path";
import { pluginDirectory } from "./project.js";

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

export function readConfig(projectRoot) {
  return readJson(path.join(pluginDirectory(projectRoot), "config.json"));
}

export function readActive(projectRoot) {
  const filePath = activePath(projectRoot);
  if (!fs.existsSync(filePath)) {
    throw new Error("No active pharo-agent image. Run pharo-agent open first.");
  }
  return readJson(filePath);
}

export function writeActive(projectRoot, value) {
  fs.mkdirSync(runtimeDirectory(projectRoot), { recursive: true });
  fs.writeFileSync(activePath(projectRoot), `${JSON.stringify(value, null, 2)}\n`);
}

export function clearActive(projectRoot) {
  fs.rmSync(activePath(projectRoot), { force: true });
}

export function resolveMountPath(projectRoot, config, imageId) {
  const root = config.mountRoot ?? ".pharo-agent/mounts";
  return path.resolve(projectRoot, root, imageId);
}

export function selectRunningImage(state) {
  const images = (state.images ?? []).filter((image) => image.status === "running");
  if (images.length !== 1) {
    throw new Error(
      `pharo-agent needs exactly one running image; PLexus reported ${images.length}.`,
    );
  }
  const image = images[0];
  if (!Array.isArray(image.mcpServers) || image.mcpServers.length !== 1) {
    throw new Error(
      `Image ${image.id} needs exactly one MCP endpoint; PLexus reported ${image.mcpServers?.length ?? 0}.`,
    );
  }
  return { image, mcpServerId: image.mcpServers[0].id };
}

export function smalltalkString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
