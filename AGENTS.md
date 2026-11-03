# pharo-agent contributor guide

`pharo-agent` is a terminal-first integration for Pharo projects. It installs
only a selected agent host's conditional instruction shim. `init` must not
write an MCP server into a host's configuration; the plugin declares one of its
own, which a host starts only where the plugin is enabled.

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

- Keep ordinary commands argument-light: `init --host`, `image start`,
  `image list`, `image stop`, and `pharo <tool> [arguments-json]`.
- Images are addressed by id, in PLexus's vocabulary: `start`, `stop`, `list`,
  never `open`, `close` or `status`. An image is a host process this project
  starts and stops; nothing here keeps a project-wide lifecycle state.
- `src/hosts.js` is the one list of supported hosts, in the order they are
  offered. The usage line, the error message, the README and the setup skill
  all follow it; do not spell the hosts out anywhere else.
- Never expose gateway URLs, ports, project roots, workspace IDs, target IDs,
  or MCP server IDs as normal agent arguments.
- Do not register template skills with an agent host. The generated root shim
  says to read `pharo.AGENTS.md` only for Pharo work; that guide selects a
  copied skill only when necessary.
- Pin runtime npm dependencies to released exact versions; do not use local
  workspace links or floating ranges.
- The setup skill and the declared MCP server must work from a plugin cache
  without `node_modules`, which is what a host installing from git gives them.
  Keep each one's `npx` command pinned to the matching CLI release, and let
  `scripts/set-version.mjs` move both pins.

## Validation

- Run `npm test` and `npm run check` after JavaScript changes. `check` type-checks
  the sources against the published types of the packages this one pins, so a pin
  bump that retires an API fails there.
- Use disposable directories for initializer tests. Preserve existing user
  guidance outside the plugin's marked managed block.
- Do not claim live image or mount validation without a disposable image and
  explicit cleanup result.
