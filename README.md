# pharo-agent

`pharo-agent` is a terminal-first Pharo integration for Codex, Claude Code, and
OpenCode. Initialize it in a Pharo project for one selected agent host:

```sh
pharo-agent init --host codex
```

It writes a small conditional instruction block, `pharo.AGENTS.md`, and
on-demand Pharo workflow skills. It does not install an agent-host MCP server.

`open` starts the project image through PLexus, loads PIFS, and mounts its
projection below `.pharo-agent/mounts`. `close` unmounts the projection and
closes the PLexus image. `pharo` calls any exposed MCP tool through the same
project route, while `mcp` provides the complete tool surface as a transient
stdio MCP bundle for tools such as mcporter.

The development package links to the local PLexus workspaces. A release will
replace those links with exact published package versions.
