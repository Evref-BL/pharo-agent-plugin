# Hosts

`pharo-agent` initializes a project for Claude Code, Codex or OpenCode:

```sh
pharo-agent init --host <claude|codex|opencode>
```

## What init writes

- a short conditional block in the host's own guide — `CLAUDE.md` for Claude
  Code, `AGENTS.md` for Codex and OpenCode — fenced between
  `<!-- pharo-agent:begin -->` and `<!-- pharo-agent:end -->`, so the rest of
  that file is left alone. The block says to read `pharo.AGENTS.md` only for
  Pharo work, which keeps Pharo guidance out of unrelated chats.
- `pharo.AGENTS.md`, the project's Pharo guide. This file is generated whole
  and says so at the top; a later `init` replaces it. It is unfenced, because
  nothing else belongs in it.
- `.pharo-agent/references` and `.pharo-agent/skills`, the workflow guidance
  the guide points at, copied from the pinned MCP template package.
- `plexus.json`, if the directory has none.

`init` acts on the current directory and never searches above it. It refuses to
run inside an enclosing PLexus project rather than initializing that root, and
refuses to replace a `pharo.AGENTS.md` it did not generate.

It does not register an MCP server with the host. `pharo-agent mcp` is there
for a chat that wants one, per project rather than globally.

## Installing as a plugin

Claude Code and Codex can install this repository as a plugin, from
`.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`. The
plugin carries one global skill, which runs the setup above for the current
project. It adds no MCP server and no Pharo tool catalogue to every chat.

OpenCode has no plugin manifest here; it uses the same CLI with
`--host opencode`.

## The first chat

The chat that runs setup has not loaded the new guidance yet, so read
`pharo.AGENTS.md` before starting Pharo work in it. Later chats pick up the
conditional block normally.
