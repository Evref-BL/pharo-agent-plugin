import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { templateDirectory as mcpTemplateDirectory } from "@evref-bl/pharo-mcp";
import { initialize } from "../src/init.js";
import { main } from "../src/cli.js";
import { supportedHosts } from "../src/hosts.js";

for (const host of supportedHosts) {
  test(`init refreshes ${host.name} assets while preserving project and runtime state`, () => {
    const root = temporaryProject();
    try {
      const hostGuide = path.join(root, host.guide);
      fs.writeFileSync(hostGuide, "# User guidance\nKeep this.\n");
      initialize({ host: host.id, cwd: root, mountRoot: ".custom-mounts" });
      fs.appendFileSync(hostGuide, "# User addition\nKeep this too.\n");

      const configPath = path.join(root, ".pharo-agent", "config.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      fs.writeFileSync(configPath, JSON.stringify({ ...config, defaultImage: "dev" }));
      const projectPath = path.join(root, "plexus.json");
      const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
      fs.writeFileSync(projectPath, JSON.stringify({ ...project, images: [{ id: "dev" }] }));
      const runtimePath = path.join(root, ".pharo-agent", "runtime", "active.json");
      fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
      fs.writeFileSync(runtimePath, '{"images":{"dev":{"imageId":"dev"}}}');
      const mountPath = path.join(root, ".custom-mounts", "dev", "source.txt");
      fs.mkdirSync(path.dirname(mountPath), { recursive: true });
      fs.writeFileSync(mountPath, "Existing projected source fixture");
      const localNote = path.join(root, ".pharo-agent", "local.md");
      fs.writeFileSync(localNote, "User-owned notes");
      const preserved = [hostGuide, configPath, projectPath, runtimePath, mountPath, localNote]
        .map((file) => [file, fs.readFileSync(file, "utf8")]);

      const generated = [
        path.join(root, "pharo.AGENTS.md"),
        path.join(root, ".pharo-agent", "references", firstReferenceName()),
        path.join(root, ".pharo-agent", "skills", "pharo-project-load", "SKILL.md"),
      ].map((file) => [file, fs.readFileSync(file, "utf8")]);
      for (const [file] of generated) fs.appendFileSync(file, "\nStale generated content\n");

      initialize({ host: host.id, cwd: root });

      for (const [file, expected] of [...generated, ...preserved]) {
        assert.equal(fs.readFileSync(file, "utf8"), expected, file);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

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

function referenceNames() {
  return fs.readdirSync(path.join(mcpTemplateDirectory(), "pharo-references")).sort();
}

function firstReferenceName() {
  const [name] = referenceNames();
  assert.ok(name, "MCP provides no Pharo reference to refresh");
  return name;
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
    for (const name of referenceNames()) {
      assert.equal(
        fs.readFileSync(path.join(root, ".pharo-agent", "references", name), "utf8"),
        fs.readFileSync(path.join(mcpTemplateDirectory(), "pharo-references", name), "utf8"),
        name,
      );
    }
    const pharoGuide = fs.readFileSync(path.join(root, "pharo.AGENTS.md"), "utf8");
    // The guide takes its routing from MCP, so what it names is whatever that
    // release ships: assert the links resolve rather than naming one of them.
    const linked = [...pharoGuide.matchAll(/\.pharo-agent\/(references|skills)\/[\w./-]+\.md/g)];
    assert.ok(linked.length > 0, "the guide links no reference or skill");
    for (const [target] of linked) {
      assert.ok(fs.existsSync(path.join(root, target)), target);
    }
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
