# Images

The commands the project's Pharo guidance hands to the agent, written out here
for a human reading along.

A project declares its images in `plexus.json`. Declaring one does not create
it; the first `image start` does.

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

`image list` shows what the project declares, which is the default, and the
mount and projection port of each image that is running. `image use <id>`
changes the default, and `image remove <id>` drops a declaration. A running
image has to be stopped before its declaration goes.

## Several images at once

`image start <id>` and `image stop <id>` name their image, the way
`image use <id>` and `image remove <id>` do. `pharo` and `mcp` take
`--image <id>`, which scopes a call rather than naming a subject. Without
either, the default image answers, so a project with one image never names an
image at all.

`image start <id>` adds an image without stopping the others, and
`image stop --all` stops every image this project started. Over `mcp`, each
Pharo tool takes the same optional `image` argument.

## Where the source projection works

An image and its Pharo tools run anywhere Node does. Projecting its source as
files needs macOS with [fuse-t](https://www.fuse-t.org/), which is an install
the user has to approve, so `image start` checks before mounting:

```json
{ "ok": true, "imageId": "dev",
  "warning": "A source projection needs macOS and fuse-t, which this platform (linux) cannot provide. Image dev is running with its Pharo tools and no source projection; read and edit its code through the tools." }
```

The image is running and fully usable; `mountPath` and `projectionPort` are
absent from `image list`, and `image stop` has nothing extra to unmount.

## Pharo versions outside the MCP range

Any version the launcher offers can be declared. MCP and the source projection
support a range of versions, and an image outside it still starts:

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
against. `image start` says so:

```json
{ "ok": true, "imageId": "p13",
  "warning": "Image p13 started with the Pharo MCP it already had, ..." }
```

A `-32601` from such an image repeats the warning: a tool that is plainly in
the catalogue, and answers that it does not exist, is otherwise a puzzle.
Recreate the image to pick the pinned version up, or set `mcp.loadPolicy` to
`always` in `plexus.json` to load it on every start.

## An image that is no longer running

`image start` on an image this project already started answers
`alreadyRunning` — but only after checking that the image is still there. A
Pharo image can exit on its own, and the record of having started it outlives
the process. Answering from the record alone hands back an endpoint nothing
answers, and every later `image start` does it again.

When the process is gone the record goes with it and the image is started
again, which `image start` reports:

```json
{ "ok": true, "imageId": "scratch", "restarted": true, "mountPath": "..." }
```

## Where things live

`.pharo-agent/mounts` holds the projections, `.pharo-agent/runtime` the record
of what is running. Both are git-ignored. Pass `--mount-root <path>` to `init`
to project somewhere else.
