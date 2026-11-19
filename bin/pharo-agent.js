#!/usr/bin/env node
import { startTelemetry } from "../src/telemetry.js";

// Before the CLI, and PLexus with it, is loaded, so the settings it reads
// reach PLexus and the images PLexus starts. It never throws, and loads
// nothing more unless the settings name an exporter.
await startTelemetry();
const { main } = await import("../src/cli.js");

main(process.argv.slice(2))
  .then((exitCode) => {
    if (exitCode) process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
