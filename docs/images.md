# Images

The commands the project's Pharo guidance hands to the agent, written out here
for a human reading along.

A project declares its images in `plexus.json`. Declaring one does not create
it; the first `open` does.

## Choosing a template

```sh
pharo-agent image templates
```

Every template the launcher offers, with the category of each. A name that two
categories offer is flagged, and needs the category as well:

```sh
pharo-agent image add old --template 'Pharo 10.0 - 64bit' --category 'Pharo Mooc'
```

`--profile <id>` puts the image under a particular launcher profile.

## Managing declarations

`image list` shows what the project declares and which is the default.
`image use <id>` changes the default, and `image remove <id>` drops a
declaration. An open image has to be closed before its declaration goes.

## Several images at once

`open`, `close`, `pharo` and `mcp` take `--image <id>`; without it the default
image answers, so a project with one image never names an image at all.

`open --image <id>` adds an image without closing the others. `close` without
`--image` closes every image this project opened. `status` takes no `--image`,
because it reports all of them. Over `mcp`, each Pharo tool takes the same
optional `image` argument.

## Pharo versions outside the MCP range

Any version the launcher offers can be declared. MCP and the source projection
support a range of versions, and an image outside it still opens:

```json
{ "ok": true, "imageId": "old", "mcp": false,
  "warning": "Pharo 10 is outside the supported Pharo MCP range (12, 13, 14, 15). ..." }
```

The image runs, and is yours to drive another way. It offers no Pharo tools
and no source projection, and a tool call against it says so.

## Where things live

`.pharo-agent/mounts` holds the projections, `.pharo-agent/runtime` the state
of what is open. Both are git-ignored. Pass `--mount-root <path>` to `init` to
project somewhere else.
