import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findProjectRoot,
  projectScope,
  resolveImageName,
  scopeFromDirectory,
  writeConfig,
} from "../src/project.js";

function temporaryDirectory() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-project-")));
}

function temporaryProject(config = {}) {
  const root = temporaryDirectory();
  writeConfig(root, config);
  return root;
}

test("the project is the nearest directory above holding .pharo-agent/config.json", () => {
  const root = temporaryProject();
  try {
    const nested = path.join(root, "src", "deep");
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(findProjectRoot(nested), root);
    assert.equal(findProjectRoot(root), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a .pharo-agent directory without its config is no project", () => {
  const root = temporaryDirectory();
  const previous = process.env.CLAUDE_PROJECT_DIR;
  try {
    delete process.env.CLAUDE_PROJECT_DIR;
    fs.mkdirSync(path.join(root, ".pharo-agent"));
    assert.throws(() => findProjectRoot(root), /No \.pharo-agent\/config\.json found.*pharo-agent init/);
  } finally {
    if (previous !== undefined) process.env.CLAUDE_PROJECT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the host says where the project is when the directory does not", () => {
  const project = temporaryProject();
  const elsewhere = temporaryDirectory();
  const previous = process.env.CLAUDE_PROJECT_DIR;
  try {
    process.env.CLAUDE_PROJECT_DIR = project;
    assert.equal(findProjectRoot(elsewhere), project);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = previous;
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("a directory name becomes a scope PLexus accepts", () => {
  assert.equal(scopeFromDirectory("/work/Pharo4Agents"), "Pharo4Agents");
  assert.equal(scopeFromDirectory("/work/My Project (2)"), "My_Project_2");
  assert.equal(scopeFromDirectory("/work/.hidden"), "hidden");
  assert.equal(scopeFromDirectory("/work/((("), "default");
  const long = scopeFromDirectory(`/work/${"a".repeat(63)} b`);
  assert.match(long, /^[A-Za-z0-9][A-Za-z0-9._]{0,63}$/);
  assert.equal(long, "a".repeat(63));
});

// A dash ends a scope in an image's directory name, so `repo-fix` as a scope
// made `repo` list, stop and delete the worktree's images as its own.
test("a dashed directory name gives a scope without dashes", () => {
  assert.equal(scopeFromDirectory("/work/repo-fix"), "repo_fix");
  assert.equal(scopeFromDirectory("/work/shop-api"), "shop_api");
  assert.equal(scopeFromDirectory("/work/a - b"), "a_b");
});

test("the scope in the config wins over the directory name", () => {
  const root = temporaryProject({ scope: "pinned" });
  try {
    assert.equal(projectScope(root), "pinned");
    writeConfig(root, {});
    assert.equal(projectScope(root), scopeFromDirectory(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// An empty scope reaches PLexus as none, which lists, and stops with --all,
// every image of every project.
test("a scope the config gets wrong is refused, naming the config", () => {
  const root = temporaryProject();
  try {
    for (const scope of ["", "shop-api", "a b", 42, null]) {
      writeConfig(root, { scope });
      assert.throws(() => projectScope(root), /The scope .* in .*config\.json is not valid/, String(scope));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a named image is taken as named, and no name means the default", () => {
  const root = temporaryProject({ defaultImage: "dev" });
  try {
    assert.equal(resolveImageName(root, "ci"), "ci");
    assert.equal(resolveImageName(root, undefined), "dev");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no name and no default points at creating an image", () => {
  const root = temporaryProject();
  try {
    assert.throws(() => resolveImageName(root, undefined), /no default image.*image create/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
