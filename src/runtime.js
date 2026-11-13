import fs from "node:fs";
import path from "node:path";
import { pluginDirectory } from "./project.js";

export function runtimeDirectory(projectRoot) {
  return path.join(pluginDirectory(projectRoot), "runtime");
}

export function projectionsPath(projectRoot) {
  return path.join(runtimeDirectory(projectRoot), "projections.json");
}

/**
 * The source projections this package mounted, by image name: the one thing
 * about a running image that PLexus cannot see. A record outlives its image
 * when the image exits on its own, so it says something only while the image
 * it names is running.
 *
 * @returns {Record<string, { mountPath: string, projectionPort: number, pifsRelease: string }>}
 */
export function readProjections(projectRoot) {
  const filePath = projectionsPath(projectRoot);
  if (!fs.existsSync(filePath)) return {};
  try {
    const recorded = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return recorded && typeof recorded === "object" && !Array.isArray(recorded) ? recorded : {};
  } catch (error) {
    throw new Error(`Cannot read ${filePath}: ${error.message}`);
  }
}

export function writeProjections(projectRoot, projections) {
  if (Object.keys(projections).length === 0) {
    fs.rmSync(projectionsPath(projectRoot), { force: true });
    return;
  }
  fs.mkdirSync(runtimeDirectory(projectRoot), { recursive: true });
  fs.writeFileSync(projectionsPath(projectRoot), `${JSON.stringify(projections, null, 2)}\n`);
}

export function recordProjection(projectRoot, name, projection) {
  writeProjections(projectRoot, { ...readProjections(projectRoot), [name]: projection });
}

export function forgetProjection(projectRoot, name) {
  const { [name]: forgotten, ...remaining } = readProjections(projectRoot);
  if (forgotten !== undefined) writeProjections(projectRoot, remaining);
}

export function resolveMountPath(projectRoot, config, name) {
  const root = config.mountRoot ?? ".pharo-agent/mounts";
  return path.resolve(projectRoot, root, name);
}

export function smalltalkString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
