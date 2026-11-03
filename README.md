# pharo-agent

Pharo code lives in a running image. The `.st` files in a repository are an
export of that image, so an agent reading them is reading a snapshot, and an
agent writing them is writing text that nothing has compiled.

`pharo-agent` hands it the image instead. It sets a project up for Claude
Code, Codex or OpenCode, starts the images that project declares, and gives
the agent the image's own tools: classes, methods, senders, tests,
refactorings, critiques. On macOS it also mounts the image's source as files,
so `rg`, a diff and an editor work on the same live image the tools answer
from.

## What it is made of

This package is the glue. Three projects do the work, and each is useful on
its own:

- [PLexus](https://github.com/Evref-BL/PLexus) creates, starts and stops the
  project's images through Pharo Launcher, keeps their state outside the
  images, and forwards MCP calls to the server inside each one.
- [MCP for Pharo](https://github.com/Evref-BL/MCP) is that server, running
  inside the image. It works through Pharo's own compiler, refactorings,
  SUnit, Iceberg and Epicea rather than patching exported text. It also
  maintains the Pharo guidance this package writes into a project.
- [pharo-image-fs](https://github.com/Evref-BL/pharo-image-fs) projects a live
  image's source as a filesystem, so ordinary file tools edit the image
  itself.

`pharo-agent` pins one released version of each, so a project gets a set that
was tested together, and gives the agent one command surface over the lot.

## Requirements

- Node 22.12 or later.
- [Pharo Launcher](https://pharo-project.github.io/pharo-launcher/), which is
  where images and their templates come from. `pharo-agent image templates`
  names what your installation offers.
- For the source projection only: macOS with
  [fuse-t](https://www.fuse-t.org/), installed with
  `brew install --cask fuse-t`. Its daemon is downloaded for you. Everywhere
  else an image starts with its Pharo tools and says the projection is
  unavailable, rather than failing.

The image tools cover Pharo 12 to 15. An image outside that range still
starts, and `image start` says what it will not have.

## Setup

In Claude Code, install it as a plugin:

```text
/plugin marketplace add Evref-BL/pharo-agent-plugin
/plugin install pharo-agent@evref-bl
```

Then ask the agent to enable Pharo tooling in a project. The plugin carries a
setup skill that runs the command below for you, and declares the `image` MCP
server, so a running image's tools reach the chat with nothing configured by
hand. [Hosts](docs/hosts.md) covers enabling it per project rather than
everywhere.

Any host can run the CLI instead, which is the whole of the setup either way.
In the project directory:

```sh
npx --yes @evref-bl/pharo-agent init --host <claude|codex|opencode>
```

From there the agent declares the image the project needs, starts it, and uses
its tools by following the guidance `init` wrote; ask it for Pharo work as you
would for anything else.

## What the agent gets

**The image's tools.** A project declares its images in `plexus.json`;
`image start` creates one from its template the first time and starts it. The
common tools are advertised — classes, methods, senders, tests, evaluation —
and the rest of the catalogue, such as repositories, change history and
debuggers, is found by searching it rather than by filling the agent's
context. [Tools](docs/tools.md) shows both, and [Images](docs/images.md)
covers templates, several images at once, and what a Pharo version outside
the supported range still does.

**Its source as files.** On macOS, `image start` mounts the image below
`.pharo-agent/mounts`, with `tonel`, `repositories`, `critiques` and `errors`
directories. A file edited there is compiled into the live image: the two
views are of one image, not of an export and an image.

**Guidance that says when to use which.** `init` writes `pharo.AGENTS.md`,
the project's Pharo guide, and a conditional block in the host's own guide —
`CLAUDE.md` for Claude Code, `AGENTS.md` for Codex and OpenCode — that points
at it only for Pharo work, so Pharo instructions stay out of unrelated chats.
The guide, its references and the workflow skills it hands to the agent are
copied from the pinned MCP release, which is where they are maintained; they
cover the awkward moments, such as a CI failure to reproduce locally, a
profile to read, an image and its Tonel files disagreeing, or an image that
has stopped answering. [Hosts](docs/hosts.md) lists every path `init` owns.

## Refreshing after an upgrade

Upgrade the package the way you installed it, then re-run
`pharo-agent init --host <claude|codex|opencode>` from the project root with
the same host. That is the refresh: it rewrites the generated guide and the
copied skills and references from the templates the new version pins.

Image declarations, runtime state, settings and any guidance outside the
host's managed block are kept, as long as you omit `--mount-root`. Generated
and copied files are overwritten, so keep project-specific instructions out of
them. Refreshing a project upgrades neither the installed package nor the code
inside a running image; [Images](docs/images.md) covers the image side.

## Reading further

`pharo-agent --help` gives the command overview, and `--help` on a command
gives its options, defaults and an example: `pharo-agent init --help`,
`pharo-agent image add --help`. Help works before a project is set up.

- [Hosts](docs/hosts.md) — what `init` writes, and installing as a plugin.
- [Images](docs/images.md) — templates and categories, several images at once,
  Pharo versions outside the MCP range.
- [Tools](docs/tools.md) — the advertised surface, finding the rest, and the
  stdio bundle.
