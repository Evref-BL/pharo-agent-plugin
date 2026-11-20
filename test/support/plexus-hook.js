// Loaded with --import before any test, and before each pharo-agent process a
// test spawns: nothing here may start a Pharo image, so every import of
// @evref-bl/plexus from then on gets the fake beside this file.
import module from "node:module";
import "./no-telemetry.js";
import { resolve } from "./plexus-resolve.js";

module.registerHooks({ resolve });
