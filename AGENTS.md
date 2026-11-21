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
  images it creates. `update-plexus.yml` moves both pins and rebuilds the
  skills.
- `scripts/set-version.mjs` moves every reference to the release: the
  manifests, the marketplace's tag and the feedback skill's version.
- Nothing is written into a user's project.

## Validation

- `npm test`. It never starts a Pharo image: the server test starts the
  declared server on a store of its own, where no image runs.
