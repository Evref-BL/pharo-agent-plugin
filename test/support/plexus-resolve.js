const fake = new URL("./fake-plexus.js", import.meta.url).href;

// The fake itself still reaches the real package, for the one value a test
// must read from the release this package pins. Synchronous, for
// registerHooks.
export function resolve(specifier, context, nextResolve) {
  if (specifier === "@evref-bl/plexus" && context.parentURL !== fake) {
    return { url: fake, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
