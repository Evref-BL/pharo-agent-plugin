# pharo-agent

`pharo-agent` is a terminal-first Pharo integration for Codex, Claude Code, and
OpenCode. It has one small setup skill; a project receives the full Pharo
guidance only after setup.

The project must already contain a `plexus.project.json` that declares one
agent-facing image. Initialize it for one selected agent host:

```sh
npx --yes @evref-bl/pharo-agent-plugin init --host codex
```

It writes a small conditional instruction block, `pharo.AGENTS.md`, and copies
on-demand Pharo workflow skills and references from the pinned MCP template
package. It does not install an agent-host MCP server.

`open` starts the project image through PLexus, loads PIFS, and mounts its
projection below `.pharo-agent/mounts`. `close` unmounts the projection and
closes the PLexus image. `pharo` calls any exposed MCP tool through the same
project route, while `mcp` exposes that tool surface as a command-scoped stdio
MCP server.

Pass `--mount-root <path>` to `init` to use a different projection root.

## Requirements

PIFS currently supports the macOS workflow and needs
[fuse-t](https://www.fuse-t.org/). Its matching daemon is downloaded by PIFS;
Go is not required at runtime.

The CLI pins released MCP and PLexus dependencies. PLexus, in turn, pins the
MCP release used to prepare the image; PIFS is loaded at its own exact release
from the image.

## Host setup

Codex and Claude Code can install the repository as a plugin. Its only global
skill initializes the current project; it does not add an MCP server or the
Pharo workflow catalogue to every chat. OpenCode uses the same CLI command
with `--host opencode`.

After initialization, the selected host guide says to read
`pharo.AGENTS.md` only for Pharo work. That guide points to local workflow
skills and references on demand. In the chat that runs setup, read that file
before beginning Pharo work; later chats load the conditional guidance normally.
