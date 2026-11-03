---
name: pharo-setup
description: Enable or refresh Pharo image tooling in the current Pharo project.
---

Run this only when the user asks to enable or refresh Pharo tooling in this project.

From the project root, run the released CLI that matches this plugin:

```sh
npx --yes @evref-bl/pharo-agent@0.12.1 init --host claude
```

Name the host this chat runs in: `--host claude` in Claude Code,
`--host codex` in Codex, `--host opencode` in OpenCode.
The command writes no host configuration. It adds a conditional instruction
block and this project's own files, so Pharo guidance stays out of unrelated
work.

To get the image's tools as MCP tools in Claude Code, enable this plugin for
this project rather than configuring a server by hand. Commit
`.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "evref-bl": {
      "source": {
        "source": "git",
        "url": "https://github.com/Evref-BL/pharo-agent-plugin.git"
      }
    }
  },
  "enabledPlugins": { "pharo-agent@evref-bl": true }
}
```

A host reads that file when a session starts, so the tools appear in the next
one. Enabling it per project keeps every other project untouched.

After upgrading the plugin/CLI, re-run the setup command from the project root
with the same host to refresh the generated guide and copied skills/references.
Those files are overwritten; keep project-specific guidance outside the host's
managed block and outside generated/copied paths. Omit `--mount-root` to retain
existing settings. Image declarations, runtime state, and live image code are
preserved. This refresh does not install a newer package or upgrade image tools.

Setup initializes the current directory, creating `plexus.json` with
no image when it is absent. Register one before the first
`pharo-agent image start`:

```sh
pharo-agent image templates
pharo-agent image add dev --template '<launcher template name>'
```

`image templates` names what the launcher offers, with the category of each.

After setup, read `pharo.AGENTS.md` in this chat before doing Pharo work. A
new chat picks up the conditional project guidance automatically.
