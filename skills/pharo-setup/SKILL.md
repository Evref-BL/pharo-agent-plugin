---
name: pharo-setup
description: Enable Pharo image tooling in the current PLexus project.
---

Run this only when the user asks to enable Pharo tooling in this project.

From the project root, run the packaged CLI with the current agent host:

```sh
node "$PLUGIN_ROOT/bin/pharo-agent.js" init --host codex
```

For Claude Code use `--host claude`; for OpenCode use `--host opencode`.
Do not configure an MCP server in the agent host. The command adds only a
conditional instruction block, so Pharo guidance stays out of unrelated work.
