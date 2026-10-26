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

Existing `plexus.json`, including image declarations, is preserved. Omit
`--mount-root` to preserve the existing plugin configuration, including custom
mount roots and the default image. Runtime records and mounted sources are
left alone; refresh does not open, close, save, or reload images.

Updating the installed package, refreshing project files, and upgrading code
inside an image are separate operations. In particular, an image opened with
MCP's `ifMissing` load policy keeps the MCP it already has. Follow the
[image update guidance](images.md#an-image-that-brought-its-own-mcp) when an
image also needs a newer MCP; re-running `init` does not perform that upgrade.

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
