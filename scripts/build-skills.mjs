#!/usr/bin/env node
// The plugin's Pharo skills are MCP's, copied from the pharo-mcp release it
// pins, so that a session gets the guidance written for the MCP its images
// hold. Run after moving that pin: the copies are committed, since a host
// reads a plugin's skills from its files, and test/skills.test.js fails while
// they differ from what this writes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { templateDirectory } from "@evref-bl/pharo-mcp";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** The skills this repository writes itself; every other directory of skills/ is built. */
export const ownSkills = ["pharo-feedback"];

/** The skill that carries MCP's guide and its references. */
export const guideSkill = "pharo-guide";

const guideFrontMatter = `---
name: ${guideSkill}
description: Read before working in a live Pharo image through these tools. Says what to check first, which skill or reference fits the task, and the workflow from inspecting a change to exporting it.
---

`;

/**
 * Writes the built skills into `skillsDirectory` from pharo-mcp's
 * `templates`: each of its `pharo-skills` as it is, and its guide as the
 * guide skill, beside the references the guide links to. Every directory
 * that is not one of `ownSkills` is replaced.
 */
export function buildSkills(templates, skillsDirectory) {
  fs.mkdirSync(skillsDirectory, { recursive: true });
  for (const entry of fs.readdirSync(skillsDirectory, { withFileTypes: true })) {
    if (entry.isDirectory() && !ownSkills.includes(entry.name)) {
      fs.rmSync(path.join(skillsDirectory, entry.name), { recursive: true, force: true });
    }
  }
  const skills = path.join(templates, "pharo-skills");
  for (const name of fs.readdirSync(skills)) {
    fs.cpSync(path.join(skills, name), path.join(skillsDirectory, name), { recursive: true });
  }
  const guide = path.join(skillsDirectory, guideSkill);
  fs.mkdirSync(guide, { recursive: true });
  // A skill is found by its name, not by a path into a project.
  const text = fs
    .readFileSync(path.join(templates, "pharo.AGENTS.md"), "utf8")
    .replace(/`skills\/(pharo-[a-z-]+)\/SKILL\.md`/g, "the `$1` skill");
  fs.writeFileSync(path.join(guide, "SKILL.md"), guideFrontMatter + text);
  fs.cpSync(path.join(templates, "pharo-references"), path.join(guide, "pharo-references"), { recursive: true });
}

/** The templates of the pharo-mcp release the plugin pins, where that release says they are. */
export const pinnedTemplates = templateDirectory();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildSkills(pinnedTemplates, path.join(root, "skills"));
}
