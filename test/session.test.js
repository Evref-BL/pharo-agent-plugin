import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sessionFile, sessionIdleMs, sessionIds, sessionTouchMs } from "../src/session.js";

const start = Date.UTC(2026, 10, 19, 9, 0, 0);
const minute = 60_000;

/** A project directory, and a clock and ids a test moves by hand. */
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-session-")));
  fs.mkdirSync(path.join(root, ".pharo-agent"));
  let time = start;
  let count = 0;
  return {
    root,
    file: sessionFile(root),
    now: () => time,
    /** @param {number} ms */
    advance: (ms) => { time += ms; },
    randomId: () => `00000000-0000-4000-8000-${String(++count).padStart(12, "0")}`,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** @param {string} file */
function mtime(file) {
  return fs.statSync(file).mtimeMs;
}

test("the session is kept in the project's runtime directory", () => {
  assert.equal(sessionFile("/project"), path.join("/project", ".pharo-agent", "runtime", "session"));
});

test("a project's session id is written once and shared by every process within half an hour", () => {
  const { root, file, now, advance, randomId, cleanup } = fixture();
  try {
    const server = sessionIds({ projectRoot: () => root, now, randomId });
    const id = server();
    assert.equal(fs.readFileSync(file, "utf8"), `${id}\n`);
    assert.equal(mtime(file), start);

    // Another process, such as a CLI command, a while later.
    advance(29 * minute);
    const cli = sessionIds({ projectRoot: () => root, now, randomId });
    assert.equal(cli(), id);
    assert.equal(mtime(file), start + 29 * minute);

    // Used within the half hour, the session goes on.
    advance(29 * minute);
    assert.equal(server(), id);
    assert.equal(sessionIds({ projectRoot: () => root, now, randomId })(), id);
  } finally {
    cleanup();
  }
});

test("a session idle for half an hour is renewed", () => {
  const { root, file, now, advance, randomId, cleanup } = fixture();
  try {
    const server = sessionIds({ projectRoot: () => root, now, randomId });
    const first = server();
    advance(sessionIdleMs);
    const second = server();
    assert.notEqual(second, first);
    assert.equal(fs.readFileSync(file, "utf8"), `${second}\n`);
    assert.equal(sessionIds({ projectRoot: () => root, now, randomId })(), second);
  } finally {
    cleanup();
  }
});

test("a process touches the session file at most once a minute", () => {
  const { root, file, now, advance, randomId, cleanup } = fixture();
  try {
    const server = sessionIds({ projectRoot: () => root, now, randomId });
    const id = server();
    // Gone from disk: a call within the minute neither reads nor writes it.
    fs.rmSync(file);
    advance(sessionTouchMs - 1);
    assert.equal(server(), id);
    assert.equal(fs.existsSync(file), false);

    fs.writeFileSync(file, `${id}\n`);
    fs.utimesSync(file, new Date(start), new Date(start));
    advance(1);
    assert.equal(server(), id);
    assert.equal(mtime(file), start + sessionTouchMs);
    advance(sessionTouchMs - 1);
    assert.equal(server(), id);
    assert.equal(mtime(file), start + sessionTouchMs);
  } finally {
    cleanup();
  }
});

test("a file that holds anything but an id is replaced, never read into a span", () => {
  const { root, file, now, randomId, cleanup } = fixture();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "/Users/someone/secret\n");
    fs.utimesSync(file, new Date(start), new Date(start));
    const id = sessionIds({ projectRoot: () => root, now, randomId })();
    assert.equal(id, "00000000-0000-4000-8000-000000000001");
    assert.equal(fs.readFileSync(file, "utf8"), `${id}\n`);
  } finally {
    cleanup();
  }
});

test("outside a project the id is the process's own, and nothing is written", () => {
  const { root, now, randomId, cleanup } = fixture();
  try {
    const none = sessionIds({ projectRoot: () => undefined, now, randomId });
    const id = none();
    assert.equal(none(), id);
    const throwing = sessionIds({ projectRoot: () => { throw new Error("no project"); }, now, randomId });
    assert.notEqual(throwing(), id);
    assert.deepEqual(fs.readdirSync(path.join(root, ".pharo-agent")), []);
  } finally {
    cleanup();
  }
});

test("a session file that cannot be written leaves the id in the process", () => {
  const { root, now, advance, randomId, cleanup } = fixture();
  try {
    // A file where the runtime directory should be.
    fs.writeFileSync(path.join(root, ".pharo-agent", "runtime"), "");
    const ids = sessionIds({ projectRoot: () => root, now, randomId });
    const id = ids();
    assert.match(id, /^00000000-/);
    advance(10 * minute);
    assert.equal(ids(), id);
  } finally {
    cleanup();
  }
});
