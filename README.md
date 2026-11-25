# pharo-agent

A plugin that gives a coding agent live Pharo images. The agent creates,
starts, stops and deletes images, and works inside the running ones: classes,
methods, senders, tests, refactorings, critiques, Iceberg, and the rest of
what a Pharo IDE does.

## What it is made of

The plugin declares one MCP server and carries skills. The work is done by:

- [PLexus](https://github.com/Evref-BL/PLexus), whose `plexus mcp` is the
  server: the image tools, and the tools of every running image, passed
  through.
- [MCP for Pharo](https://github.com/Evref-BL/MCP), the server inside each
  image, which works through Pharo's own compiler, refactorings, SUnit,
  Iceberg and Epicea. Its Pharo skills and guide are this plugin's skills,
  copied from the release PLexus loads into the images it creates.

Each release pins one released version of both, tested together.

## Requirements

- Node 22.15 or later.
- [Pharo Launcher](https://pharo-project.github.io/pharo-launcher/), which is
  where templates and VMs come from.

## Installing

In Claude Code:

```text
/plugin marketplace add Evref-BL/pharo-agent-plugin
/plugin install pharo-agent@evref-bl
```

The marketplace installs the latest release. A new one arrives once the
marketplace is updated: turn auto-update on under **Marketplaces** in
`/plugin`, or run `/plugin marketplace update evref-bl`.

To enable it only where Pharo work happens, commit this to a project's
`.claude/settings.json`, which brings the marketplace with it:

```json
{
  "extraKnownMarketplaces": {
    "evref-bl": {
      "source": { "source": "git", "url": "https://github.com/Evref-BL/pharo-agent-plugin.git" }
    }
  },
  "enabledPlugins": { "pharo-agent@evref-bl": true }
}
```

Codex installs it from the same repository. OpenCode has no plugins of this
kind: add PLexus's server to the project's `opencode.json` instead.
`codemode: false` keeps OpenCode from hiding its tools inside `execute`:

```json
{
  "mcp": {
    "pharo": {
      "type": "local",
      "command": ["npx", "--yes", "@evref-bl/plexus", "mcp", "--project", "."],
      "enabled": true,
      "codemode": false
    }
  }
}
```

Nothing is written into the project.

## What the agent gets

**Images of its own.** The `image_*` tools list the launcher's templates,
create an image from one, start, stop and delete it, and list the images and
which run. A project's images are those of its scope, the project
directory's name, so each project sees its own. An image takes one writer,
so an agent creates one per subject rather than share one.
[PLexus's documentation](https://github.com/Evref-BL/PLexus/blob/main/docs/mcp-server.md)
says what each tool does.

**The tools of each running image.** A call names the image it is for, and
may leave it out while only one runs. The common tools are listed; the image
searches the rest itself, so their schemas stay out of the context. What
exists depends on the MCP the image holds.

**Pharo guidance.** MCP's `pharo-*` skills, and its guide as the
`pharo-guide` skill, which says what to check first and which skill or
reference fits a task.

**A way to report what got in its way.** The `pharo-feedback` skill has the
agent look back over the conversation for tool calls that failed, misled it
or needed a workaround, and for steps the guidance never asked for, and draft
issues for the tools' maintainers, or a pull request where the fix is small.
It searches for existing issues first, and files only what you approve.

## Tracing

PLexus traces the calls it serves with OpenTelemetry once settings name an
exporter, and sends nothing otherwise. It reads them from its own settings
file, `~/.config/plexus/otel.env`: when the file gives settings, they replace
any `OTEL_*` the agent host passed down, and otherwise the environment
decides. PLexus passes them on to the images it starts. By default, a span records names, never values: no
argument, answer, path, or image or project name. [PLexus's telemetry guide](https://github.com/Evref-BL/PLexus/blob/main/docs/telemetry.md) says
what each span holds.
