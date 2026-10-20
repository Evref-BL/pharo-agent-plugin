import fs from "node:fs";
import path from "node:path";
import { templateDirectory as mcpTemplateDirectory } from "@evref-bl/pharo-mcp";
import {
  createProjectConfig,
  enclosingProjectRoot,
  pluginDirectory,
  projectConfigFileName,
  projectConfigPath,
} from "./project.js";

const managedStart = "<!-- pharo-agent:begin -->";
const managedEnd = "<!-- pharo-agent:end -->";

const hostGuide = {
  claude: "CLAUDE.md",
  codex: "AGENTS.md",
  opencode: "AGENTS.md",
};

function copyDirectory(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function assertManagedBlockCanBeUpdated(filePath) {
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const start = current.indexOf(managedStart);
  const end = current.indexOf(managedEnd);
  if ((start === -1) !== (end === -1) || (end !== -1 && end < start)) {
    throw new Error(`Cannot update incomplete pharo-agent block in ${filePath}`);
  }
}

function updateManagedBlock(filePath, content) {
  assertManagedBlockCanBeUpdated(filePath);
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const start = current.indexOf(managedStart);
  const end = current.indexOf(managedEnd);

  const block = `${managedStart}\n${content}\n${managedEnd}\n`;
  const updated = start === -1
    ? `${current}${current && !current.endsWith("\n") ? "\n" : ""}${block}`
    : `${current.slice(0, start)}${block}${current.slice(end + managedEnd.length).replace(/^\n?/, "")}`;
  fs.writeFileSync(filePath, updated);
}

function writeIfMissing(filePath, content) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content);
  }
}

function assertGeneratedGuideCanBeUpdated(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  if (
    content.trimEnd() !== pharoGuide().trimEnd()
    && (!content.includes(managedStart) || !content.includes(managedEnd))
  ) {
    throw new Error(`Refusing to replace user-owned ${filePath}`);
  }
}

function guidance() {
  return `# Pharo work\n\nWhen the task uses Pharo, read \`pharo.AGENTS.md\` before acting.\n`;
}

function pharoGuide() {
  return `# Pharo project guide

\`plexus.json\` declares this project's images. A freshly initialized
project declares none; register one before the first \`pharo-agent open\`:

\`\`\`sh
pharo-agent image list
pharo-agent image add dev --template '<launcher template name>'
\`\`\`

\`image add\` makes the first registered image the default. \`pharo-agent image
use <id>\` changes the default, and \`pharo-agent image remove <id>\` drops a
declaration. Close an image before removing its declaration.

Use \`pharo-agent open\` before live-image work and edit projected source under
\`.pharo-agent/mounts\`. Use \`pharo-agent pharo list\` to inspect the complete
live MCP tool surface and \`pharo-agent pharo <tool> [arguments-json]\` to call
a tool. \`pharo-agent mcp\` exposes the image as a command-scoped stdio MCP
server.

Several images can be open at once. Every image-facing command takes
\`--image <id>\`; without it the default image answers. \`pharo-agent open
--image <id>\` opens another image without closing the first,
\`pharo-agent status\` lists what is open, and \`pharo-agent close\` closes
everything this project opened.

Image, Tonel, Iceberg, disk Git, and host processes are separate states.

## Read first

- Before Pharo source changes, read the project guidance. If absent, read the
  local [coding rules](.pharo-agent/references/pharo-coding-rules.md) and
  [coding style](.pharo-agent/references/pharo-coding-style.md).
- Before loading a project, read
  [.pharo-agent/skills/pharo-project-load/SKILL.md](.pharo-agent/skills/pharo-project-load/SKILL.md).
- Before cross-version work, read
  [.pharo-agent/skills/pharo-version-compat/SKILL.md](.pharo-agent/skills/pharo-version-compat/SKILL.md).
- Before exporting image changes or changing Git state, read
  [.pharo-agent/skills/pharo-image-git-handoff/SKILL.md](.pharo-agent/skills/pharo-image-git-handoff/SKILL.md).
- Before reproducing smalltalkCI or GitHub failures, read
  [.pharo-agent/skills/pharo-ci-repro/SKILL.md](.pharo-agent/skills/pharo-ci-repro/SKILL.md).
- Before recovering a stopped standalone image, read
  [.pharo-agent/skills/pharo-mcp-recovery/SKILL.md](.pharo-agent/skills/pharo-mcp-recovery/SKILL.md).
- Before debugger sessions or repairs, read the local
  [debugging guide](.pharo-agent/references/debugging.md).

## Workflow

1. Inspect the tool schema before acting; do not rely on remembered names.
2. Prefer the least-mutating dedicated tool; use \`image_evaluate\` only when
   no dedicated tool fits.
3. Verify identity before mutation, make the narrowest change, then run focused
   tests.
4. Use the image-to-Git handoff skill before export or commit.
`;
}

function resolveInitProjectRoot(cwd) {
  const projectRoot = path.resolve(cwd);
  if (fs.existsSync(projectConfigPath(projectRoot))) {
    return { projectRoot, createdProjectConfig: false };
  }

  const enclosing = enclosingProjectRoot(projectRoot);
  if (enclosing) {
    throw new Error(
      `${projectRoot} is inside the PLexus project at ${enclosing}. `
        + `Initialize that project root, or remove its ${projectConfigFileName}.`,
    );
  }

  return { projectRoot, createdProjectConfig: true };
}

export function initialize({ host, mountRoot, cwd = process.cwd() }) {
  const guideName = hostGuide[host];
  if (!guideName) {
    throw new Error("--host must be codex, claude, or opencode");
  }

  const { projectRoot, createdProjectConfig } = resolveInitProjectRoot(cwd);
  const directory = pluginDirectory(projectRoot);
  const configPath = path.join(directory, "config.json");
  const pharoGuidePath = path.join(projectRoot, "pharo.AGENTS.md");
  assertGeneratedGuideCanBeUpdated(pharoGuidePath);
  assertManagedBlockCanBeUpdated(path.join(projectRoot, guideName));
  if (createdProjectConfig) {
    createProjectConfig(projectRoot);
  }
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(configPath) || mountRoot !== undefined) {
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({ mountRoot: mountRoot ?? ".pharo-agent/mounts" }, null, 2)}\n`,
    );
  }
  writeIfMissing(path.join(directory, ".gitignore"), "mounts/\nruntime/\n");
  updateManagedBlock(pharoGuidePath, pharoGuide());
  const templates = mcpTemplateDirectory();
  copyDirectory(path.join(templates, "pharo-references"), path.join(directory, "references"));
  copyDirectory(path.join(templates, "pharo-skills"), path.join(directory, "skills"));
  updateManagedBlock(path.join(projectRoot, guideName), guidance());

  return { projectRoot, guideName, createdProjectConfig };
}
