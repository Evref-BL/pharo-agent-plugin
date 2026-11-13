import { Images, defaultPharoMcpVersion } from "@evref-bl/plexus";
import { projectScope, readConfig, writeConfig } from "./project.js";
import { forgetProjection, liveProjection } from "./runtime.js";

/** PLexus's images, seen through this project's scope. */
export function projectImages(projectRoot) {
  return new Images({ scope: projectScope(projectRoot) });
}

/**
 * An image made from the pinned MCP keeps the MCP it was made with, so once
 * the pin moves its tools can differ from the ones the current guidance
 * describes. Only a pin can be compared: a script's MCP is its author's.
 *
 * @param {{ name: string, mcp?: { source: "pin", version: string } | { source: "script", script: string } }} row
 */
export function olderMcpWarning(row) {
  if (row.mcp?.source !== "pin" || row.mcp.version === defaultPharoMcpVersion) return undefined;
  return `Image ${row.name} holds Pharo MCP ${row.mcp.version}, and images are created with`
    + ` ${defaultPharoMcpVersion} now, so its tools may differ from the current ones.`
    + " Recreating it gives it the current MCP.";
}

export async function listImageTemplates(projectRoot) {
  return { templates: await projectImages(projectRoot).templates() };
}

/**
 * @param {string} projectRoot
 * @param {unknown} [defaultImage] the image a call naming none goes to: the
 *   project's, unless a server was started with another
 */
export async function listImages(projectRoot, defaultImage = readConfig(projectRoot).defaultImage) {
  const rows = await projectImages(projectRoot).list();
  return {
    ...(typeof defaultImage === "string" ? { defaultImage } : {}),
    images: rows.map((row) => {
      const projection = liveProjection(projectRoot, row);
      const warning = olderMcpWarning(row);
      return {
        ...row,
        isDefault: row.name === defaultImage,
        ...(projection ? { mountPath: projection.mountPath, projectionPort: projection.projectionPort } : {}),
        ...(warning ? { warning } : {}),
      };
    }),
  };
}

/**
 * @param {string} projectRoot
 * @param {string} name
 * @param {{ template: string, category?: string, script?: string, everyStart?: boolean }} options
 */
export async function createImage(projectRoot, name, options) {
  const created = await projectImages(projectRoot).create(name, options);
  const config = readConfig(projectRoot);
  const isDefault = config.defaultImage === undefined;
  if (isDefault) {
    writeConfig(projectRoot, { ...config, defaultImage: name });
  }
  return { ...created, isDefault };
}

export async function useImage(projectRoot, name) {
  // Listing it is how PLexus says it exists; a default naming nothing would
  // only fail later, on whichever command first leans on it.
  await projectImages(projectRoot).list(name);
  writeConfig(projectRoot, { ...readConfig(projectRoot), defaultImage: name });
  return { defaultImage: name };
}

export async function deleteImage(projectRoot, name) {
  const deleted = await projectImages(projectRoot).delete(name);
  forgetProjection(projectRoot, name);
  const { defaultImage, ...rest } = readConfig(projectRoot);
  if (defaultImage === name) {
    writeConfig(projectRoot, rest);
  }
  return { ...deleted, ...(defaultImage === name ? { clearedDefault: true } : {}) };
}
