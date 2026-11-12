# pharo-agent

`pharo-agent` gives a coding agent a Pharo Launcher of its own. It can see the
templates the launcher offers, create images from them, start and stop them,
and work inside the ones it started: classes, methods, senders, tests,
refactorings, critiques, and the rest of what a Pharo IDE does. On macOS it
can also read and edit an image's source as files.

It works with Claude Code, Codex and OpenCode.

## What it is made of

This plugin is the glue. Three projects do the work, and each is useful on its
own:

- [PLexus](https://github.com/Evref-BL/PLexus) drives Pharo Launcher. It
  creates, starts and stops a project's images, keeps their state outside the
  images, and forwards MCP calls to the server running in each one.
- [MCP for Pharo](https://github.com/Evref-BL/MCP) is that server. It works
  through Pharo's own compiler, refactorings, SUnit, Iceberg and Epicea rather
  than patching exported text, and it maintains the Pharo guidance a project
  gets.
- [pharo-image-fs](https://github.com/Evref-BL/pharo-image-fs) projects a live
  image's source as a filesystem, so ordinary file tools edit the image
  itself.

The plugin pins one released version of each, so a project gets a set that was
tested together, and gives the agent one command surface over the lot.

## Requirements

- Node 22.12 or later.
- [Pharo Launcher](https://pharo-project.github.io/pharo-launcher/), which is
  where images and templates come from.
- For editing source as files: macOS with [fuse-t](https://www.fuse-t.org/),
  installed with `brew install --cask fuse-t`. Its daemon is downloaded for
  you. Everywhere else images start with their Pharo tools and no projection,
  rather than failing.

The image tools cover Pharo 12 to 15. An image outside that range still
starts, and says what it will not have.

## Setup

In Claude Code, install it as a plugin:

```text
/plugin marketplace add Evref-BL/pharo-agent-plugin
/plugin install pharo-agent@evref-bl
```

Then ask the agent to enable Pharo tooling in a project. The plugin carries a
setup skill that does it, and declares the `pharo` MCP server, so a running
image's tools reach the chat with nothing configured by hand.
[Hosts](docs/hosts.md) covers enabling it per project rather than everywhere.

Any host can run the CLI instead. In the project directory, once:

```sh
npx --yes @evref-bl/pharo-agent init --host <claude|codex|opencode>
```

## What the agent gets

**The launcher.** `image templates` names every template the installation
offers. `image add <id> --template <name>` declares an image, and
`image start <id>` creates it from that template the first time and starts it.
A project can declare as many images as it likes — one per Pharo version, one
to throw away — and run them at once; `image list` says what is declared and
what is running. [Images](docs/images.md) has the rest.

**The tools of each running image.** Classes, methods, senders, tests and
evaluation are advertised; the fuller catalogue, such as packages,
repositories, change history and debuggers, is searched rather than listed, so
its schemas stay out of the agent's context. The tools belong to the image, so
what exists depends on what that image has loaded. [Tools](docs/tools.md)
covers both, and serving a different MCP from an image.

**Source as files, on macOS.** Starting an image mounts its source below
`.pharo-agent/mounts`. A file edited there is compiled into the live image:
the files and the tools are two views of one image, not of an export and an
image. Setting `PHARO_AGENT_PROJECTION=off` in the environment starts images
without mounting anything.

**Guidance for the agent.** Setting a project up writes a Pharo guide into it,
and a conditional line in the host's own guide pointing at that guide for
Pharo work only, so Pharo instructions stay out of unrelated chats. The guide
and what it refers to are maintained by the MCP project and copied from the
release this plugin pins. [Hosts](docs/hosts.md) lists the paths it owns.

**A way to report what got in its way.** The plugin's feedback skill has the
agent look back over the conversation for tool calls that failed, misled it or
needed a workaround, and draft issues for the tools' maintainers. It offers
itself at the end of Pharo work where that happened, searches for existing
issues first, and files only the drafts you approve.

## Refreshing after an upgrade

Upgrade the plugin the way you installed it, then run the setup command again
in the project, naming the same host. That rewrites the generated guide and
the files copied with it, from the templates the new version pins.

Image declarations, runtime state and settings are kept, as long as you omit
`--mount-root`, and so is anything outside the block the plugin marks as its
own. Generated and copied files are overwritten, so keep project-specific
instructions out of them. Refreshing a project upgrades neither the installed
plugin nor the code inside a running image; [Images](docs/images.md) covers
the image side.

## Reading further

`pharo-agent --help` gives the command overview, and `--help` on a command
gives its options, defaults and an example. Help works before a project is set
up.

- [Hosts](docs/hosts.md) — what setup writes, and installing as a plugin.
- [Images](docs/images.md) — templates and categories, several images at once,
  Pharo versions outside the MCP range.
- [Tools](docs/tools.md) — the advertised surface, finding the rest, the stdio
  bundle, and serving a different MCP.
