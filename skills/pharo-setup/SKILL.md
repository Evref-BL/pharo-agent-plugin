---
name: pharo-setup
description: Enable or refresh Pharo image tooling in the current Pharo project.
---

Run this only when the user asks to enable or refresh Pharo tooling in this project.

From the project root, run the released CLI that matches this plugin:

```sh
npx --yes @evref-bl/pharo-agent@0.6.0 init --host claude
```

Name the host this chat runs in: `--host claude` in Claude Code,
`--host codex` in Codex, `--host opencode` in OpenCode.
Do not configure an MCP server in the agent host. The command adds only a
conditional instruction block, so Pharo guidance stays out of unrelated work.

After upgrading the plugin/CLI, re-run the setup command from the project root
with the same host to refresh the generated guide and copied skills/references.
Those files are overwritten; keep project-specific guidance outside the host's
managed block and outside generated/copied paths. Omit `--mount-root` to retain
existing settings. Image declarations, runtime state, and live image code are
preserved. This refresh does not install a newer package or upgrade image tools.

Setup initializes the current directory, creating `plexus.json` with
no image when it is absent. Register one before the first `pharo-agent open`:

```sh
pharo-agent image templates
pharo-agent image add dev --template '<launcher template name>'
```

`image templates` names what the launcher offers, with the category of each.

After setup, read `pharo.AGENTS.md` in this chat before doing Pharo work. A
new chat picks up the conditional project guidance automatically.
