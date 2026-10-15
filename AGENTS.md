# pharo-agent contributor guide

`pharo-agent` is a terminal-first integration for Pharo projects. It installs
only a selected agent host's conditional instruction shim. It must not register
an MCP server with Codex, Claude Code, or OpenCode.

## Boundaries

- PLexus owns image lifecycle, runtime state, and image endpoint discovery.
- MCP owns semantic image operations.
- pharo-image-fs owns the projection protocol and mount daemon.
- This package owns project initialization, conditional guidance, command
  orchestration, and only resources recorded as plugin-owned.
- The MCP forwarding bridge is process-scoped: it reads PLexus state, serves
  one terminal command over stdio, then exits. Do not add an HTTP gateway,
  gateway port, or a background route service.

## Interface

- Use **agent host** in prose and `--host` as the only host selector.
- Keep ordinary commands argument-light: `init --host`, `open`, `status`,
  `close`, and `pharo <tool> [arguments-json]`.
- Never expose gateway URLs, ports, project roots, workspace IDs, target IDs,
  or MCP server IDs as normal agent arguments.
- Do not register template skills with an agent host. The generated root shim
  says to read `pharo.AGENTS.md` only for Pharo work; that guide selects a
  copied skill only when necessary.

## Validation

- Run `npm test` and `npm run check` after JavaScript changes.
- Use disposable directories for initializer tests. Preserve existing user
  guidance outside the plugin's marked managed block.
- Do not claim live image or mount validation without a disposable image and
  explicit cleanup result.
