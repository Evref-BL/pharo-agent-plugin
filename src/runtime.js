import fs from "node:fs";
import path from "node:path";
import { loadProjectState } from "@evref-bl/plexus";
import { configuredImages, pluginDirectory } from "./project.js";

export function runtimeDirectory(projectRoot) {
  return path.join(pluginDirectory(projectRoot), "runtime");
}

export function runningImagesPath(projectRoot) {
  return path.join(runtimeDirectory(projectRoot), "running.json");
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

// A project can hold a plexus.json this plugin never initialized, and now that
// an image can be declared from a chat it is reached before `.pharo-agent`
// exists. An absent settings file is a project with no settings, not an error
// about a path the caller never named.
export function readConfig(projectRoot) {
  const filePath = configPath(projectRoot);
  if (!fs.existsSync(filePath)) return {};
  return readJson(filePath);
}

export function writeConfig(projectRoot, config) {
  fs.mkdirSync(pluginDirectory(projectRoot), { recursive: true });
  fs.writeFileSync(configPath(projectRoot), `${JSON.stringify(config, null, 2)}\n`);
}

export function readRunningImages(projectRoot) {
  const filePath = runningImagesPath(projectRoot);
  if (!fs.existsSync(filePath)) return {};
  const recorded = readJson(filePath);
  return recorded && typeof recorded.images === "object" && recorded.images !== null
    ? recorded.images
    : {};
}

export function writeRunningImages(projectRoot, images) {
  if (Object.keys(images).length === 0) {
    fs.rmSync(runningImagesPath(projectRoot), { force: true });
    return;
  }
  fs.mkdirSync(runtimeDirectory(projectRoot), { recursive: true });
  fs.writeFileSync(runningImagesPath(projectRoot), `${JSON.stringify({ images }, null, 2)}\n`);
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
      + "choose one with pharo-agent image use <id>, or name one.",
  );
}

export function resolveImageId(projectRoot, imageId) {
  if (imageId === undefined) return defaultImageId(projectRoot);
  if (!configuredImages(projectRoot).some((image) => image.id === imageId)) {
    throw new Error(`Image ${imageId} is not configured.`);
  }
  return imageId;
}

export function readRunningImage(projectRoot, imageId) {
  const resolved = resolveImageId(projectRoot, imageId);
  const running = readRunningImages(projectRoot)[resolved];
  if (!running) {
    throw new Error(
      `Image ${resolved} is not running. Run pharo-agent image start ${resolved} first.`,
    );
  }
  if (running.mcp === false) {
    throw new Error(
      `Image ${resolved} is running without MCP, so it offers no Pharo tools. `
        + "Register an image on a Pharo version the MCP contract supports to use them.",
    );
  }
  return running;
}

// A record in the project's runtime state says this project started the image,
// not that the image is still there. PLexus reclaims a dead image's port and
// relaunches on the next start, so the only thing standing between a crashed
// image and a working one is believing the record.
export function imageProcessIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // The process is someone else's, which is still a process.
    return error.code === "EPERM";
  }
}

export function recordedImageIsRunning(record) {
  // PLexus owns the state file, so PLexus reads it: a hand-rolled JSON.parse
  // here was this package deciding what another package's format means.
  const state = loadProjectState(record.statePath);
  const image = state?.images.find((candidate) => candidate.id === record.imageId);
  return image?.status === "running" && imageProcessIsAlive(image.pid);
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

// `mcp.loadPolicy` defaults to ifMissing, so an image that already carries a
// Pharo MCP keeps it and the version this project pins is never loaded. That
// is a supported way to run — it is what the policy is for — but nothing said
// so, and the image's tools then quietly differ from the ones the project was
// written against. PLexus records it; this says it.
//
// An image copied from a home image cache base is another matter: PLexus keys
// a base on what preparing it loaded and says whether that is still what the
// project loads. A `current` base holds the project's own MCP, and warning
// about it told every new image the opposite of what happened; an `outdated`
// one certainly holds another. Only an image nobody can vouch for gets the
// hedged warning.
export function unappliedPharoMcpPin(image) {
  const load = image?.pharoMcpLoad;
  if (load?.state !== "provided" || load.preparedBase === "current") return undefined;
  if (load.preparedBase === "outdated") {
    return `Image ${image.id} kept the Pharo MCP it was prepared with, which is not the one this project`
      + " loads now, so its tools may differ from the ones this project expects."
      + " Recreate the image, or set mcp.loadPolicy to always.";
  }
  return `Image ${image.id} started with the Pharo MCP it already had, so the version this project pins`
    + " was not loaded and its tools may differ from the ones this project expects."
    + " Recreate the image, or set mcp.loadPolicy to always.";
}

export function smalltalkString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
