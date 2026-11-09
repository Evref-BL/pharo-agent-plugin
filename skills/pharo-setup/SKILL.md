---
name: pharo-setup
description: Enable or refresh Pharo image tooling in the current Pharo project.
---

Run this only when the user asks to enable or refresh Pharo tooling in this project.

From the project root, run the released CLI that matches this plugin, naming
the host this chat runs in: `--host claude` in Claude Code, `--host codex` in
Codex, `--host opencode` in OpenCode.

```sh
npx --yes @evref-bl/pharo-agent@0.15.0 init --host claude
```

It writes the project's Pharo guide, skills and references, and a block in the
host's guide that points to them; no host configuration. Re-running it after
an upgrade replaces those files and keeps image declarations and image code.

In Claude Code, enable the plugin for this project in `.claude/settings.json`;
the next session gets the tools:

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

Then declare the project's first image, its default:

```sh
pharo-agent image templates
pharo-agent image add dev --template '<launcher template name>'
```

Read `pharo.AGENTS.md` before doing Pharo work.
