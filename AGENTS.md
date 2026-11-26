# pharo-agent contributor guide

The plugin is manifests, a server declaration and skills. It has no code of
its own to run: `.mcp.json` starts PLexus's `plexus mcp` from the plugin's
dependencies, in the host's project.

## Boundaries

- PLexus owns images and the server: the image tools, passing calls to an
  image, the server's instructions to the host, and its telemetry.
- MCP owns the tools inside an image and the Pharo guidance. The `pharo-*`
  skills here, apart from `pharo-feedback`, are copies built from the pinned
  `@evref-bl/pharo-mcp` by `npm run skills`. Fix them in MCP's templates;
  never edit a copy.
- This repository owns the manifests, the marketplaces, `.mcp.json`, the
  `pharo-feedback` skill and the release.

## Rules

- Pin dependencies to exact released versions. A host installs them only
  then, and a release is a combination that was tested.
- The `@evref-bl/pharo-mcp` pin is the MCP release PLexus loads into the
  images it creates. `update-plexus.yml` moves both pins, rebuilds the
  skills and moves the README's PLexus release with them.
- `scripts/set-version.mjs` moves every reference to the release: the
  manifests and the feedback skill's version.
- The marketplaces install from `stable`, which the release workflow moves to
  a release once its tag exists.
- A release is major when what the README's Versions section lists changes,
  a tool's name or arguments included.
- Nothing is written into a user's project.

## Validation

- `npm test`. It never starts a Pharo image: the server test starts the
  declared server on a store of its own, where no image runs.
