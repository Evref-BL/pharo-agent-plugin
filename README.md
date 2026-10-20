# pharo-agent

`pharo-agent` is a terminal-first Pharo integration for Codex, Claude Code, and
OpenCode. It has one small setup skill; a project receives the full Pharo
guidance only after setup.

Initialize the current directory for one selected agent host:

```sh
npx --yes @evref-bl/pharo-agent init --host codex
```

It writes a small conditional instruction block, `pharo.AGENTS.md`, and copies
on-demand Pharo workflow skills and references from the pinned MCP template
package. It does not install an agent-host MCP server.

`init` acts on the current directory and never searches above it. If that
directory has no `plexus.project.json`, it creates one that declares the
project and no image; an existing one is left untouched. It refuses to run
inside an enclosing PLexus project rather than initializing that project root.

Register the image the project needs before the first `open`:

```sh
pharo-agent image add dev --template 'Pharo 13.0 - 64bit (stable)'
```

`image add` registers a template-created image with the pinned MCP load policy,
and the first one registered becomes the default. `image list`,
`image use <id>` (change the default) and `image remove <id>` cover the rest;
an open image must be closed before its declaration is removed.

`open` starts an image through PLexus, loads PIFS, and mounts its projection
below `.pharo-agent/mounts`. `close` unmounts the projection and closes the
PLexus image. `pharo` calls any exposed MCP tool through the same project
route, while `mcp` exposes that tool surface as a command-scoped stdio MCP
server.

Several images can be open at once. `open`, `close`, `status`, `pharo` and
`mcp` all accept `--image <id>`; without it the default image answers, so a
project with one image never mentions an image at all. `open --image <id>`
adds an image without closing the others, and `close` without `--image` closes
every image this project opened. Over `mcp`, each Pharo tool takes the same
optional `image` argument.

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
