import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initialize } from "../src/init.js";

function temporaryProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-"));
  fs.writeFileSync(path.join(root, "plexus.project.json"), "{}\n");
  return root;
}

test("init adds a conditional Codex block without replacing existing guidance", () => {
  const root = temporaryProject();
  try {
    const agents = path.join(root, "AGENTS.md");
    fs.writeFileSync(agents, "# Existing guidance\nKeep this.\n");

    const result = initialize({ host: "codex", cwd: path.join(root, "src") });

    assert.equal(result.projectRoot, root);
    assert.equal(result.guideName, "AGENTS.md");
    assert.match(fs.readFileSync(agents, "utf8"), /# Existing guidance/);
    assert.match(fs.readFileSync(agents, "utf8"), /When the task uses Pharo, read `pharo\.AGENTS\.md`/);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, ".pharo-agent", "config.json"), "utf8")),
      { mountRoot: ".pharo-agent/mounts" },
    );
    assert.ok(fs.existsSync(path.join(root, ".pharo-agent", "skills", "pharo-project-load", "SKILL.md")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("init replaces only its own managed block", () => {
  const root = temporaryProject();
  try {
    initialize({ host: "claude", cwd: root });
    const guide = path.join(root, "CLAUDE.md");
    fs.appendFileSync(guide, "# User addition\nKeep this too.\n");

    initialize({ host: "claude", cwd: root });

    const content = fs.readFileSync(guide, "utf8");
    assert.equal((content.match(/pharo-agent:begin/g) ?? []).length, 1);
    assert.match(content, /# User addition/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
