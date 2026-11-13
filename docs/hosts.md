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
- for OpenCode only, the `pharo` entry under `mcp` in the project's
  `opencode.json`, keeping the rest of that file. See below.
- `.pharo-agent/config.json`, which makes the directory a project: the scope
  that tells its images from other projects' (see [Images](images.md)), taken
  from the directory's name, and the mount root.
- `.pharo-agent/.gitignore`, which keeps `config.json`, `mounts/` and
  `runtime/` out of git, adding whichever of them it lacks. They describe this
  checkout's images, so a clone, or a worktree outside the project, runs
  `init` and gets images of its own. A worktree inside the project gets no
  config through git, so it finds the project's and shares its images.

`init` acts on the current directory and never searches above it. It refuses to
run inside an enclosing project, one with its own `.pharo-agent/config.json`,
rather than initializing that root, and refuses to replace a `pharo.AGENTS.md`
it did not generate.

It does not register an MCP server with the host. `pharo-agent mcp` is there
for a chat that wants one, per project rather than globally.

## Refreshing after an upgrade

Upgrade the plugin/CLI using the same method you used to install it. Then run
that version's `pharo-agent init --host <claude|codex|opencode>` from each
project root, selecting the same host as before. Re-running `init` is the
project refresh operation; it uses the templates pinned by the executing CLI.

The refresh replaces `pharo.AGENTS.md` and same-named files copied into
`.pharo-agent/references` and `.pharo-agent/skills`. It replaces only the
pharo-agent block in the selected host's guide. Put project-specific guidance
outside that block, and keep custom files separate from the generated/copied
paths. Unrelated files are not removed during refresh.

The existing `.pharo-agent/config.json` is kept as it is; `--mount-root`
changes only its mount root. Its scope is the one `init` wrote when it made
the config, so renaming the directory does not part the project from its
images; a config without one uses the scope the directory's name gives.
Runtime records and mounted sources are left alone; refresh does not create,
start, stop, save, or delete images.

Updating the installed package, refreshing project files, and upgrading code
inside an image are separate operations. In particular, an image keeps the MCP
it was created with; [Images](images.md#an-image-made-with-another-mcp) says
how to give it the pinned one, which re-running `init` does not do.

## Installing as a plugin

Claude Code and Codex can install this repository as a plugin, from
`.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`. In
Claude Code:

```text
/plugin marketplace add Evref-BL/pharo-agent-plugin
/plugin install pharo-agent@evref-bl
```

The plugin carries one skill, which runs the setup above for the current
project, and declares the `pharo` MCP server. A host starts that server when a
session starts, so a chat where the plugin is enabled reaches the image's
tools with nothing configured by hand; it loads the server's name and
instructions, not every tool definition.

Enabling the plugin only where Pharo work happens keeps every other project
untouched. Committing this to a project's `.claude/settings.json` does that,
and brings the marketplace with it:

```json
{
  "extraKnownMarketplaces": {
    "evref-bl": {
      "source": {
        "source": "git",
        "url": "https://github.com/Evref-BL/pharo-agent-plugin.git"
      }
    }
  },
  "enabledPlugins": { "pharo-agent@evref-bl": true }
}
```

The declared server is the plugin's own `bin/pharo-agent.js`, under
`${CLAUDE_PLUGIN_ROOT}`. Claude Code installs a plugin's npm dependencies with
it, so the copy in the plugin cache runs as it does from a checkout, and the
chat always talks to the version of the code it installed.

A new release does not arrive on its own: a marketplace auto-updates only
once you turn that on, under **Marketplaces** in `/plugin`. Otherwise run
`/plugin marketplace update evref-bl` first, or Claude Code compares against
the catalog it fetched when you installed and reports that you are up to date.

OpenCode has no plugin manifest here, so `init --host opencode` declares the
server itself, in the project's `opencode.json`, which OpenCode reads for that
project only. The entry runs `npx --yes @evref-bl/pharo-agent@<version> mcp`,
pinned to the release that ran `init`, and sets `"codemode": false`: OpenCode 2
otherwise hides an MCP server's tools inside its `execute` tool, where a model
has to search for them. A project configured with `opencode.jsonc`, or an
`opencode.json` that is not plain JSON, is refused rather than rewritten
without its comments, and the error gives the entry to add by hand.

## The first chat

The chat that runs setup has not loaded the new guidance yet, so read
`pharo.AGENTS.md` before starting Pharo work in it. Later chats pick up the
conditional block normally.
