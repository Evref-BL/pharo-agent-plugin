import fs from "node:fs";
import path from "node:path";
import { pluginDirectory } from "./project.js";

export function runtimeDirectory(projectRoot) {
  return path.join(pluginDirectory(projectRoot), "runtime");
}

export function projectionPath(projectRoot, name) {
  return path.join(runtimeDirectory(projectRoot), "projections", `${name}.json`);
}

/**
 * @typedef {{ mountPath: string, projectionPort: number, pifsRelease: string, pids: number[] }} Projection
 */

/**
 * @param {unknown} value
 * @returns {value is Projection}
 */
function isProjection(value) {
  if (!value || typeof value !== "object") return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  return typeof record.mountPath === "string"
    && typeof record.projectionPort === "number"
    && typeof record.pifsRelease === "string"
    && Array.isArray(record.pids)
    && record.pids.every((pid) => typeof pid === "number");
}

/**
 * The source projection this package mounted on an image, the one thing about
 * a running image that PLexus cannot see. One file per image, so that two
 * sessions starting different images never write the same file.
 *
 * Every record is written whole and renamed into place, so one that does not
 * read as a record was not written by this package, and is no record: the
 * projection is an extra, and must not stand between an agent and stopping or
 * listing its images.
 *
 * @returns {Projection | undefined}
 */
export function readProjection(projectRoot, name) {
  let recorded;
  try {
    recorded = JSON.parse(fs.readFileSync(projectionPath(projectRoot, name), "utf8"));
  } catch {
    return undefined;
  }
  return isProjection(recorded) ? recorded : undefined;
}

/**
 * The projection of the VM running an image now. A record outlives a VM that
 * exits on its own, and the image may since run in a VM started elsewhere,
 * with no projection, so a record holds only for the VMs it was made with.
 *
 * @param {{ name: string, pids: number[] }} row a PLexus list row
 */
export function liveProjection(projectRoot, row) {
  const projection = readProjection(projectRoot, row.name);
  return projection && projection.pids.some((pid) => row.pids.includes(pid)) ? projection : undefined;
}

/** @param {Projection} projection */
export function recordProjection(projectRoot, name, projection) {
  const filePath = projectionPath(projectRoot, name);
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(projection, null, 2)}\n`);
  fs.renameSync(temporary, filePath);
}

export function forgetProjection(projectRoot, name) {
  fs.rmSync(projectionPath(projectRoot, name), { force: true });
}

export function resolveMountPath(projectRoot, config, name) {
  const root = config.mountRoot ?? ".pharo-agent/mounts";
  return path.resolve(projectRoot, root, name);
}

export function smalltalkString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
