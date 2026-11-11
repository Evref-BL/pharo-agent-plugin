// An image tool called from the shell, the way an agent reaches for it:
// `pharo-agent class_get Point`, `pharo-agent method_compile --class Point
// --source - <<'EOF'`. The flags are the tool's own arguments, read from its
// schema, so a number reaches the image as a number and a boolean flag needs
// no value. An argument that is itself an object takes JSON as its value.
import fs from "node:fs";

// The CLI's own options, which no tool argument can shadow.
export const cliOptions = new Set(["--image", "--json", "--help"]);

/** A word the CLI reads as a tool: every image tool is snake_case. */
export function isToolName(word) {
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(word);
}

function kebab(name) {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function typesOf(property) {
  return [property?.type].flat().filter(Boolean);
}

function flagsText(schema) {
  return Object.keys(schema?.properties ?? {}).map((name) => `--${name}`).join(", ") || "none";
}

/** The property a bare value fills: the one required, or the only one. */
export function positionalProperty(schema) {
  const required = schema?.required ?? [];
  if (required.length === 1) return required[0];
  const names = Object.keys(schema?.properties ?? {});
  return required.length === 0 && names.length === 1 ? names[0] : undefined;
}

function propertyNamed(flag, schema, toolName) {
  const properties = schema?.properties ?? {};
  const name = Object.keys(properties).find((each) => each === flag || kebab(each) === flag);
  if (!name) {
    throw new Error(`${toolName} has no argument --${flag}. Its arguments: ${flagsText(schema)}.`);
  }
  return name;
}

function scalar(value, property, name, toolName) {
  const types = typesOf(property);
  if (types.includes("integer") || types.includes("number")) {
    const number = Number(value);
    if (value.trim() === "" || !Number.isFinite(number)) {
      throw new Error(`${toolName} --${name} takes a number, not ${JSON.stringify(value)}.`);
    }
    return number;
  }
  if (types.includes("boolean") && !types.includes("string")) {
    if (value === "true" || value === "false") return value === "true";
    throw new Error(`${toolName} --${name} is true or false, not ${JSON.stringify(value)}.`);
  }
  if (types.includes("object") && !types.includes("string")) {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`${toolName} --${name} takes a JSON object.`);
    }
  }
  return value;
}

// An array argument gathers each use of its flag; an argument that takes a
// string or an array of them, such as method_compile's source, is a string
// until the flag comes a second time.
function assign(parsed, name, value, property, toolName) {
  const types = typesOf(property);
  if (types.includes("array")) {
    const item = scalar(value, property.items ?? {}, name, toolName);
    if (!Object.hasOwn(parsed, name)) {
      parsed[name] = types.includes("string") ? value : [item];
    } else {
      parsed[name] = [parsed[name]].flat().concat(item);
    }
    return;
  }
  if (Object.hasOwn(parsed, name)) {
    throw new Error(`${toolName} takes --${name} once.`);
  }
  parsed[name] = scalar(value, property, name, toolName);
}

/**
 * The tool arguments the words give. `schema` is the tool's input schema;
 * `readStdin` answers standard input, for a value written as `-`.
 */
export function toolArguments(toolName, words, schema, readStdin = () => fs.readFileSync(0, "utf8")) {
  const properties = schema?.properties ?? {};
  const flags = {};
  let stdinUsed = false;
  const valueOf = (word) => {
    if (word !== "-") return word;
    if (stdinUsed) throw new Error(`${toolName} reads one value from stdin, not two.`);
    stdinUsed = true;
    return readStdin().replace(/\r?\n$/, "");
  };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word.startsWith("--") && word.length > 2) {
      const [flag, inline] = word.slice(2).split(/=(.*)/s, 2);
      const negated = flag.startsWith("no-") && !Object.hasOwn(properties, flag)
        && !Object.keys(properties).some((each) => kebab(each) === flag);
      const name = propertyNamed(negated ? flag.slice(3) : flag, schema, toolName);
      const property = properties[name];
      const types = typesOf(property);
      if (types.includes("boolean") && !types.includes("string")) {
        if (inline !== undefined) assign(flags, name, inline, property, toolName);
        else if (words[index + 1] === "true" || words[index + 1] === "false") {
          assign(flags, name, words[index + 1], property, toolName);
          index += 1;
        } else {
          assign(flags, name, negated ? "false" : "true", property, toolName);
        }
        continue;
      }
      if (negated) throw new Error(`${toolName} --${name} is not a boolean, so --no-${flag.slice(3)} means nothing.`);
      let value = inline;
      if (value === undefined) {
        value = words[index + 1];
        if (value === undefined) throw new Error(`${toolName} --${name} needs a value; - reads it from stdin.`);
        index += 1;
      }
      assign(flags, name, valueOf(value), property, toolName);
      continue;
    }
    const positional = positionalProperty(schema);
    if (!positional) {
      throw new Error(`${toolName} takes its arguments as flags: ${flagsText(schema)}.`);
    }
    // Bare words for a text argument are one text, as a shell splits
    // `tool_search repository commit` into two.
    const types = typesOf(properties[positional]);
    if (Object.hasOwn(flags, positional) && types.includes("string") && !types.includes("array")) {
      flags[positional] = `${flags[positional]} ${valueOf(word)}`;
      continue;
    }
    assign(flags, positional, valueOf(word), properties[positional], toolName);
  }
  return flags;
}

/** What a tool answered, as the text it wrote for a reader. */
export function resultText(result) {
  const texts = (result?.content ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text);
  if (texts.length > 0) return texts.join("\n");
  return JSON.stringify(result?.structuredContent ?? result ?? {}, null, 2);
}

function firstLine(text) {
  return String(text ?? "").split("\n", 1)[0].trim();
}

// What a list has room for: the first sentence, which every tool's
// description opens with what it does.
function firstSentence(text) {
  const line = firstLine(text);
  const end = line.search(/\.(\s|$)/);
  return end === -1 ? line : line.slice(0, end + 1);
}

/** One line per tool, then where the rest of the catalogue is. */
export function toolListing(tools) {
  const width = Math.max(0, ...tools.map((tool) => tool.name.length));
  return [
    ...tools.map((tool) => `${tool.name.padEnd(width)}  ${firstSentence(tool.description)}`),
    "",
    "These are the advertised tools. pharo-agent tool_search <words> finds the rest;",
    "pharo-agent <tool> --help shows a tool's arguments.",
  ].join("\n");
}

function typeText(property) {
  const types = typesOf(property);
  if (types.includes("array")) {
    return `<${typesOf(property.items).join("|") || "value"}>, repeatable`;
  }
  if (types.includes("boolean")) return "";
  return `<${types.join("|") || "value"}>`;
}

/** A tool's own usage, from its schema. */
export function toolUsage(tool) {
  const schema = tool.inputSchema ?? {};
  const required = new Set(schema.required ?? []);
  const positional = positionalProperty(schema);
  const entries = Object.entries(schema.properties ?? {}).map(([name, property]) => {
    const head = [`--${name}`, typeText(property), required.has(name) ? "(required)" : ""]
      .filter(Boolean).join(" ");
    return { head, description: firstLine(property.description) };
  });
  const width = Math.max(0, ...entries.map((entry) => entry.head.length));
  const usageLine = `pharo-agent ${tool.name}${positional ? ` [<${positional}>]` : ""}`
    + `${entries.length ? " [--<argument> <value>]..." : ""} [--image <id>] [--json]`;
  return [
    "Usage:",
    `  ${usageLine}`,
    "",
    firstLine(tool.description) ? String(tool.description).trim() : "",
    ...(entries.length ? ["", "Arguments:", ...entries.map((entry) => `  ${entry.head.padEnd(width)}  ${entry.description}`)] : []),
    "",
    [
      positional ? `A bare value is --${positional}.` : "",
      Object.values(schema.properties ?? {}).some((property) => typesOf(property).includes("boolean"))
        ? "A flag without a type is true alone, false as --no-<flag>." : "",
      "A value of - is read from stdin. --json prints the MCP result.",
    ].filter(Boolean).join(" "),
  ].join("\n");
}
