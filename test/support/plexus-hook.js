// Loaded with --import before any test, and before each pharo-agent process a
// test spawns: nothing here may start a Pharo image, so every import of
// @evref-bl/plexus from then on gets the fake beside this file.
import module from "node:module";
import { resolve } from "./plexus-resolve.js";

// registerHooks arrived in Node 22.15, after the 22.12 this package supports,
// and register warns that it is deprecated where both exist.
if (typeof module.registerHooks === "function") {
  module.registerHooks({ resolve });
} else {
  module.register("./plexus-resolve.js", import.meta.url);
}
