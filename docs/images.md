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

## An image that brought its own MCP

An image that already carries a Pharo MCP keeps it: `mcp.loadPolicy` defaults
to `ifMissing`, so the version the project pins is not loaded over one that is
already there. That is what the policy is for, and the image works, but its
tools are whatever that MCP has rather than what this project was written
against. `open` says so:

```json
{ "ok": true, "imageId": "p13",
  "warning": "Image p13 opened with the Pharo MCP it already had, ..." }
```

A `-32601` from such an image repeats the warning: a tool that is plainly in
the catalogue, and answers that it does not exist, is otherwise a puzzle.
Recreate the image to pick the pinned version up, or set `mcp.loadPolicy` to
`always` in `plexus.json` to load it on every open.

## An image that is no longer running

`open` on an image this project already opened answers `alreadyOpen` — but
only after checking that the image is still there. A Pharo image can exit on
its own, and the record of having opened it outlives the process. Answering
from the record alone hands back an endpoint nothing answers, and every later
`open` does it again.

When the process is gone the record goes with it and the image is opened
again, which `open` reports:

```json
{ "ok": true, "imageId": "scratch", "restarted": true, "mountPath": "..." }
```

## Where things live

`.pharo-agent/mounts` holds the projections, `.pharo-agent/runtime` the state
of what is open. Both are git-ignored. Pass `--mount-root <path>` to `init` to
project somewhere else.
