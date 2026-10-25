// The agent hosts this CLI initializes, in the order they are offered. One
// list, so the usage line, the error message and the documentation cannot
// drift apart or disagree about which hosts exist.
export const supportedHosts = [
  { id: "claude", name: "Claude Code", guide: "CLAUDE.md", plugin: true },
  { id: "codex", name: "Codex", guide: "AGENTS.md", plugin: true },
  { id: "opencode", name: "OpenCode", guide: "AGENTS.md", plugin: false },
];

export const hostIds = supportedHosts.map((host) => host.id);

export function hostNamed(id) {
  return supportedHosts.find((host) => host.id === id);
}

export function guideForHost(id) {
  return hostNamed(id)?.guide;
}

// "claude|codex|opencode", for the usage line.
export function hostChoices() {
  return hostIds.join("|");
}

// "claude, codex, or opencode", for a sentence.
export function hostList() {
  if (hostIds.length < 2) return hostIds.join("");
  return `${hostIds.slice(0, -1).join(", ")}, or ${hostIds.at(-1)}`;
}
