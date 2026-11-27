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

Each release pins one PLexus release and the MCP release that PLexus loads
into the images it creates.

## Requirements

- Node 22.15 or later, with `node` and `npm` on the `PATH` the agent host
  runs with.
- [Pharo Launcher](https://pharo-project.github.io/pharo-launcher/), which is
  where templates and VMs come from.
- Network access to create an image: the Launcher downloads its template and
  VM, and the image loads MCP from GitHub.

## Installing

### Claude Code

```text
/plugin marketplace add Evref-BL/pharo-agent-plugin
/plugin install pharo-agent@evref-bl
```

The marketplace installs the latest release, and installing writes nothing
into the project. A new release arrives at the next session once auto-update
is on for the marketplace, under **Marketplaces** in `/plugin`. Otherwise
`/plugin` updates it under **Installed**, as does
`claude plugin update pharo-agent@evref-bl` in a shell.

To enable it only where Pharo work happens, install it for the project, in
each clone:

```sh
claude plugin marketplace add Evref-BL/pharo-agent-plugin
claude plugin install pharo-agent@evref-bl --scope project
```

### Codex and OpenCode

Neither takes the whole plugin: Codex does not tell a plugin's server which
project it serves, and OpenCode has no plugins of this kind. The plugin's
installer writes what each needs into the project instead. Run it there:

```sh
npx --yes @evref-bl/pharo-agent@latest install --host codex
npx --yes @evref-bl/pharo-agent@latest install --host opencode
```

It copies the skills into `.agents/skills`, and adds the `pharo` server,
running the PLexus the release pins, to `.codex/config.toml` or
`opencode.json`, keeping everything else they hold, skills of your own
included. Running it again installs the latest release over what it wrote,
which `.agents/skills/.pharo-agent.json` records. Committed, these files give
every clone the same setup.

Codex reads `.codex/config.toml` only in a project it trusts, which it asks
the first time it starts there; until then the skills arrive without the
server. In OpenCode the entry sets `codemode: false`, which keeps OpenCode
from hiding its tools inside `execute`.

## What the agent gets

**Images of its own.** The `image_*` tools list the launcher's templates,
create an image from one, start, stop and delete it, and list the images and
which run. A project's images are those of its scope, the name of the
project's directory, so projects whose directories share a name share their
images. An image takes one writer, so an agent creates one per subject rather
than share one.
[PLexus's documentation](https://github.com/Evref-BL/PLexus/blob/v1.2.0/docs/mcp-server.md)
says what each tool does.

**The tools of each running image.** Every call names the image it is for: a
call that names none goes to the only image running, which may be another
session's. The common tools are listed; the image searches the rest itself,
so their schemas stay out of the context. What exists depends on the MCP the
image holds.

**Pharo guidance.** MCP's `pharo-*` skills, and its guide as the
`pharo-guide` skill, which says what to check first and which skill or
reference fits a task.

**A way to report what got in its way.** The `pharo-feedback` skill has the
agent look back over the conversation for tool calls that failed, misled it
or needed a workaround, and for steps the guidance never asked for, and draft
issues for the tools' maintainers, or a pull request where the fix is small.
It searches for existing issues first, and files only what you approve.

## Tracing

PLexus traces the calls it serves with OpenTelemetry once its settings name an
exporter, and sends nothing otherwise.
[PLexus's observability guide](https://github.com/Evref-BL/PLexus/blob/v1.2.0/docs/observability.md)
says where the settings go and what each span holds.

## Versions

A major release changes what a user of the plugin relies on:

- the plugin's name, its marketplace's, the server's name `pharo`, and the
  skills' names;
- the tools it serves, the image tools and those of the images it creates, by
  name and arguments, as PLexus and MCP version them.

The skills, and the tools' descriptions and answers, are text for a model,
whose wording may change in any release.
