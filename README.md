# pharo-agent

`pharo-agent` gives a coding agent a live Pharo image: semantic tools over MCP,
and the image's source projected as files it can read and edit. It works with
Claude Code, Codex and OpenCode.

## Setup

In the project directory:

```sh
npx --yes @evref-bl/pharo-agent init --host <claude|codex|opencode>
```

That is all of it. `init` writes the project's Pharo guidance and copies the
workflow skills that guidance refers to. From there the agent registers the
image the project needs, opens it and uses its tools by following what was
written; ask it for Pharo work as you would for anything else.

## Requirements

Node 22.12 or later.

The source projection currently supports macOS and needs
[fuse-t](https://www.fuse-t.org/). Its daemon is downloaded for you.

## What the agent gets

Reference, for reading rather than typing: these are the commands the guidance
hands to the agent.

- [Hosts](docs/hosts.md) — what `init` writes, and installing as a plugin.
- [Images](docs/images.md) — templates and categories, several images at once,
  Pharo versions outside the MCP range.
- [Tools](docs/tools.md) — the advertised surface, finding the rest, and the
  stdio bundle.
