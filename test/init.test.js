import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { templateDirectory as mcpTemplateDirectory } from "@evref-bl/pharo-mcp";
import { initialize } from "../src/init.js";
import { main } from "../src/cli.js";

for (const host of ["codex", "claude", "opencode"]) {
  test(`init omits host-discovery metadata for ${host}'s soft-loaded skills`, () => {
    const root = temporaryProject();
    try {
      initialize({ host, cwd: root });
      const skills = path.join(root, ".pharo-agent", "skills");
      for (const skill of fs.readdirSync(skills)) {
        assert.ok(fs.existsSync(path.join(skills, skill, "SKILL.md")));
        assert.equal(fs.existsSync(path.join(skills, skill, "agents")), false);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-"));
}

function temporaryProject() {
  const root = temporaryDirectory();
  fs.writeFileSync(
    path.join(root, "plexus.json"),
    `${JSON.stringify({ id: "existing", name: "existing", images: [] })}\n`,
  );
  return root;
}

test("init adds a conditional Codex block without replacing existing guidance", () => {
  const root = temporaryProject();
  try {
    const agents = path.join(root, "AGENTS.md");
    fs.writeFileSync(agents, "# Existing guidance\nKeep this.\n");

    const result = initialize({ host: "codex", cwd: root });

    assert.equal(result.projectRoot, root);
    assert.equal(result.guideName, "AGENTS.md");
    assert.match(fs.readFileSync(agents, "utf8"), /# Existing guidance/);
    assert.match(fs.readFileSync(agents, "utf8"), /When the task uses Pharo, read `pharo\.AGENTS\.md`/);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, ".pharo-agent", "config.json"), "utf8")),
      { mountRoot: ".pharo-agent/mounts" },
    );
    assert.ok(fs.existsSync(path.join(root, ".pharo-agent", "skills", "pharo-project-load", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(root, ".pharo-agent", "references", "pharo-coding-rules.md")));
    assert.equal(
      fs.readFileSync(path.join(root, ".pharo-agent", "references", "pharo-coding-rules.md"), "utf8"),
      fs.readFileSync(path.join(mcpTemplateDirectory(), "pharo-references", "pharo-coding-rules.md"), "utf8"),
    );
    const pharoGuide = fs.readFileSync(path.join(root, "pharo.AGENTS.md"), "utf8");
    assert.match(pharoGuide, /\.pharo-agent\/references\/pharo-coding-rules\.md/);
    assert.doesNotMatch(pharoGuide, /https?:\/\//);
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

test("init refuses to replace an existing user-owned Pharo guide", () => {
  const root = temporaryProject();
  try {
    const guide = path.join(root, "pharo.AGENTS.md");
    fs.writeFileSync(guide, "# My Pharo guide\n");

    assert.throws(() => initialize({ host: "codex", cwd: root }), /user-owned/);
    assert.equal(fs.readFileSync(guide, "utf8"), "# My Pharo guide\n");
    assert.equal(fs.existsSync(path.join(root, ".pharo-agent")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("init does not create assets when the selected host guide has an incomplete block", () => {
  const root = temporaryProject();
  try {
    fs.writeFileSync(path.join(root, "AGENTS.md"), "<!-- pharo-agent:begin -->\n");

    assert.throws(() => initialize({ host: "codex", cwd: root }), /incomplete/);
    assert.equal(fs.existsSync(path.join(root, ".pharo-agent")), false);
    assert.equal(fs.existsSync(path.join(root, "pharo.AGENTS.md")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("init changes the mount root only when explicitly requested", () => {
  const root = temporaryProject();
  try {
    initialize({ host: "codex", cwd: root, mountRoot: ".mounts" });
    initialize({ host: "codex", cwd: root });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, ".pharo-agent", "config.json"), "utf8")),
      { mountRoot: ".mounts" },
    );

    initialize({ host: "codex", cwd: root, mountRoot: ".other-mounts" });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, ".pharo-agent", "config.json"), "utf8")),
      { mountRoot: ".other-mounts" },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the Pharo guide is wholly generated, so it carries no fence", () => {
  const root = temporaryProject();
  try {
    initialize({ host: "claude", cwd: root });

    const guide = fs.readFileSync(path.join(root, "pharo.AGENTS.md"), "utf8");
    assert.doesNotMatch(guide, /pharo-agent:begin|pharo-agent:end/);
    assert.match(guide, /Generated by `pharo-agent init`/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a guide fenced by the preceding release is adopted and unfenced", () => {
  const root = temporaryProject();
  try {
    const guide = path.join(root, "pharo.AGENTS.md");
    fs.writeFileSync(guide, "<!-- pharo-agent:begin -->\n# Pharo project guide\n<!-- pharo-agent:end -->\n");

    initialize({ host: "claude", cwd: root });

    const content = fs.readFileSync(guide, "utf8");
    assert.doesNotMatch(content, /pharo-agent:begin/);
    assert.match(content, /Generated by `pharo-agent init`/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("help does not require a PLexus project", async () => {
  await main(["--help"]);
});

test("init creates an empty PLexus project config in the current directory", () => {
  const root = temporaryDirectory();
  try {
    const result = initialize({ host: "claude", cwd: root });

    assert.equal(result.projectRoot, root);
    assert.equal(result.createdProjectConfig, true);
    const config = JSON.parse(
      fs.readFileSync(path.join(root, "plexus.json"), "utf8"),
    );
    assert.deepEqual(config.images, []);
    assert.equal(config.name, path.basename(root));
    assert.ok(config.id);
    assert.ok(fs.existsSync(path.join(root, "CLAUDE.md")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("init keeps an existing PLexus project config", () => {
  const root = temporaryProject();
  try {
    const result = initialize({ host: "codex", cwd: root });

    assert.equal(result.createdProjectConfig, false);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, "plexus.json"), "utf8")).id,
      "existing",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("init refuses to initialize inside an enclosing PLexus project", () => {
  const root = temporaryProject();
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  try {
    assert.throws(() => initialize({ host: "codex", cwd: nested }), /is inside the PLexus project at/);
    assert.equal(fs.existsSync(path.join(nested, "plexus.json")), false);
    assert.equal(fs.existsSync(path.join(root, "AGENTS.md")), false);
    assert.equal(fs.existsSync(path.join(nested, ".pharo-agent")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
