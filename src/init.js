import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findProjectRoot, pluginDirectory } from "./project.js";

const managedStart = "<!-- pharo-agent:begin -->";
const managedEnd = "<!-- pharo-agent:end -->";

const hostGuide = {
  claude: "CLAUDE.md",
  codex: "AGENTS.md",
  opencode: "AGENTS.md",
};

function templateDirectory() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../templates");
}

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

function updateManagedBlock(filePath, content) {
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const start = current.indexOf(managedStart);
  const end = current.indexOf(managedEnd);
  if ((start === -1) !== (end === -1) || (end !== -1 && end < start)) {
    throw new Error(`Cannot update incomplete pharo-agent block in ${filePath}`);
  }

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

function guidance() {
  return `# Pharo work\n\nWhen the task uses Pharo, read \`pharo.AGENTS.md\` before acting.\n`;
}

function pharoGuide() {
  return `# Pharo project guide

Use \`pharo-agent open\` before live-image work and edit projected source under
\`.pharo-agent/mounts\`. Use \`pharo-agent pharo list\` to inspect the complete
live MCP tool surface and \`pharo-agent pharo <tool> [arguments-json]\` to call
a tool. \`pharo-agent mcp\` is a command-scoped stdio bundle for MCP clients
such as mcporter.

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

export function initialize({ host, mountRoot, cwd = process.cwd() }) {
  const guideName = hostGuide[host];
  if (!guideName) {
    throw new Error("--host must be codex, claude, or opencode");
  }

  const projectRoot = findProjectRoot(cwd);
  const directory = pluginDirectory(projectRoot);
  const configPath = path.join(directory, "config.json");
  fs.mkdirSync(directory, { recursive: true });
  writeIfMissing(
    configPath,
    `${JSON.stringify({ mountRoot: mountRoot ?? ".pharo-agent/mounts" }, null, 2)}\n`,
  );
  writeIfMissing(path.join(directory, ".gitignore"), "mounts/\nruntime/\n");
  fs.writeFileSync(path.join(projectRoot, "pharo.AGENTS.md"), pharoGuide());
  copyDirectory(path.join(templateDirectory(), "references"), path.join(directory, "references"));
  copyDirectory(path.join(templateDirectory(), "skills"), path.join(directory, "skills"));
  updateManagedBlock(path.join(projectRoot, guideName), guidance());

  return { projectRoot, guideName };
}
