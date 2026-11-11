// tool_get answers a tool's contract as YAML, written by MCP's MCPYamlWriter,
// and through PLexus that text is all there is: no structured content. The
// writer's subset is small and fixed, so it is read here rather than with a
// YAML library: block mappings indented by two spaces, `{}` and `[]`, flow
// lists of scalars, block lists whose entries sit at their key's indent, and
// scalars that are either plain words or JSON (quoted strings, numbers, true,
// false, null).

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function scalar(text) {
  const value = text.trim();
  if (value.startsWith("\"")) return JSON.parse(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)) return Number(value);
  return value;
}

function flowList(text) {
  const inner = text.trim().slice(1, -1);
  const items = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (quoted && character === "\\") {
      current += character + inner[index + 1];
      index += 1;
      continue;
    }
    if (character === "\"") quoted = !quoted;
    if (!quoted && character === ",") {
      items.push(scalar(current));
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) items.push(scalar(current));
  return items;
}

// A key is a plain word or a JSON string, followed by a colon and then a
// space or the end of the line.
const keyPattern = /^("(?:[^"\\]|\\.)*"|[^\s"][^:]*?):(?: (.*))?$/;

function inlineValue(text) {
  const value = text.trim();
  if (value === "{}") return {};
  if (value.startsWith("[")) return flowList(value);
  return scalar(value);
}

function parseMapping(lines, start, indent) {
  const mapping = {};
  let index = start;
  while (index < lines.length && indentOf(lines[index]) === indent && !lines[index].trimStart().startsWith("- ")) {
    const match = keyPattern.exec(lines[index].slice(indent));
    if (!match) throw new Error(`Unreadable tool contract line: ${lines[index]}`);
    const key = match[1].startsWith("\"") ? JSON.parse(match[1]) : match[1];
    index += 1;
    if (match[2] !== undefined) {
      mapping[key] = inlineValue(match[2]);
    } else if (index < lines.length && indentOf(lines[index]) === indent && lines[index].trimStart().startsWith("- ")) {
      [mapping[key], index] = parseSequence(lines, index, indent);
    } else {
      [mapping[key], index] = parseMapping(lines, index, indent + 2);
    }
  }
  return [mapping, index];
}

function parseSequence(lines, start, indent) {
  const sequence = [];
  let index = start;
  while (index < lines.length && indentOf(lines[index]) === indent && lines[index].trimStart().startsWith("- ")) {
    const entry = lines[index].slice(indent + 2);
    if (keyPattern.test(entry)) {
      const nested = [`${" ".repeat(indent + 2)}${entry}`, ...lines.slice(index + 1)];
      const [mapping, consumed] = parseMapping(nested, 0, indent + 2);
      sequence.push(mapping);
      index += consumed;
    } else {
      sequence.push(inlineValue(entry));
      index += 1;
    }
  }
  return [sequence, index];
}

/** The contract tool_get answered, or undefined when the text holds none. */
export function toolContractFrom(text) {
  const lines = String(text).split("\n");
  const start = lines.findIndex((line) => line === "tool:");
  if (start === -1) return undefined;
  const [contract] = parseMapping(lines, start + 1, 2);
  return contract;
}
