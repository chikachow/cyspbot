import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";

export function parseScopeDocument(text, json = false) {
  if (typeof text !== "string") throw new Error("Missing file content");
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error("Ambiguous document");
  const value = doc.toJS({ maxAliasCount: 0 });
  // YAML parsing checks duplicate keys; JSON parsing enforces the manifest syntax.
  if (json && !isDeepStrictEqual(value, JSON.parse(text))) throw new Error("Invalid manifest");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid document root");
  return value;
}

export function semanticOperations(file, before, after) {
  const result = [];
  const object = (value) => value && typeof value === "object" && !Array.isArray(value);
  function diff(path, left, right, hasLeft = true, hasRight = true) {
    if (hasLeft && hasRight && isDeepStrictEqual(left, right)) return;
    if (hasLeft && hasRight && object(left) && object(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort((a, b) =>
        a.localeCompare(b),
      )) {
        diff(
          [...path, key],
          left[key],
          right[key],
          Object.hasOwn(left, key),
          Object.hasOwn(right, key),
        );
      }
    } else {
      result.push({
        file,
        path,
        ...(hasLeft ? { before: left } : {}),
        ...(hasRight ? { after: right } : {}),
      });
    }
  }
  diff([], before, after);
  return result;
}
