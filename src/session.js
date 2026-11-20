// The working session a span belongs to, for a host that passes no trace
// context: a random id kept in the project's runtime directory, shared by
// the MCP server and the CLI that work in that project, and renewed once
// nothing has used it for half an hour. It names a stretch of work, never who
// did it. Nothing here throws: an id that cannot be kept in the project is
// kept in the process.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runtimeDirectory } from "./runtime.js";

/** How long a session lasts without a call. */
export const sessionIdleMs = 30 * 60_000;

/** How often a process touches the session file at most. */
export const sessionTouchMs = 60_000;

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** @param {string} projectRoot */
export function sessionFile(projectRoot) {
  return path.join(runtimeDirectory(projectRoot), "session");
}

/**
 * The id the file holds while its session lasts, touched; otherwise a new
 * one, written whole and renamed into place. The file's mtime is when the
 * session was last used. What the file holds goes into spans, so anything but
 * an id this package writes is replaced, not read.
 *
 * @param {string} file
 * @param {number} now
 * @param {() => string} randomId
 */
function keptId(file, now, randomId) {
  const at = new Date(now);
  try {
    if (now - fs.statSync(file).mtimeMs < sessionIdleMs) {
      const id = fs.readFileSync(file, "utf8").trim();
      if (idPattern.test(id)) {
        fs.utimesSync(file, at, at);
        return id;
      }
    }
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== "ENOENT") throw error;
  }
  const id = randomId();
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, `${id}\n`);
  fs.utimesSync(temporary, at, at);
  fs.renameSync(temporary, file);
  return id;
}

/**
 * A source of the current session id. In a project, the id its runtime
 * directory keeps, which the process reads and touches at most once a minute;
 * outside one, an id of the process's own, never written.
 *
 * @param {{
 *   projectRoot: () => string | undefined,
 *   now?: () => number,
 *   randomId?: () => string,
 * }} options `projectRoot` answers undefined, or throws, where there is no project
 * @returns {() => string}
 */
export function sessionIds({ projectRoot, now = Date.now, randomId = randomUUID }) {
  /** @type {string | undefined} */
  let processId;
  /** @type {{ root: string, id: string, touchedAt: number } | undefined} */
  let kept;
  const ownId = () => {
    processId ??= randomId();
    return processId;
  };
  return () => {
    let root;
    try {
      root = projectRoot();
    } catch {
      root = undefined;
    }
    if (!root) return ownId();
    const time = now();
    if (kept?.root === root && time - kept.touchedAt < sessionTouchMs) return kept.id;
    let id;
    try {
      id = keptId(sessionFile(root), time, randomId);
    } catch {
      id = kept?.root === root ? kept.id : ownId();
    }
    kept = { root, id, touchedAt: time };
    return id;
  };
}
