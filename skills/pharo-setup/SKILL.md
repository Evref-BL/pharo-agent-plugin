---
name: pharo-setup
description: Enable Pharo image tooling in the current PLexus project.
---

Run this only when the user asks to enable Pharo tooling in this project.

From the project root, run the released CLI that matches this plugin:

```sh
npx --yes @evref-bl/pharo-agent-plugin@0.1.0 init --host codex
```

Use `--host claude` in Claude Code and `--host opencode` in OpenCode.
Do not configure an MCP server in the agent host. The command adds only a
conditional instruction block, so Pharo guidance stays out of unrelated work.

After setup, read `pharo.AGENTS.md` in this chat before doing Pharo work. A
new chat picks up the conditional project guidance automatically.
