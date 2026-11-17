/** Read only diagnostic fields: never serialize arbitrary rejection payloads,
 * DOM trees, request/response bodies, or user input. Browser getters can throw. */
const read = (value: unknown, key: string): unknown => {
  try {
    return value !== null &&
      (typeof value === "object" || typeof value === "function")
      ? Reflect.get(value, key)
      : undefined;
  } catch {
    return undefined;
  }
};
const isArray = (value: unknown): boolean => {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
};
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0
    ? value.slice(0, 2048)
    : undefined;

export const describeRejection = (reason: unknown) => {
  const extra: Record<string, unknown> = {
    rejectionType:
      reason === null ? "null" : isArray(reason) ? "array" : typeof reason,
  };
  const name = text(read(reason, "name"));
  const message = text(read(reason, "message"));
  const originalStack = read(reason, "stack");
  const stack = typeof originalStack === "string" ? originalStack : undefined;
  const className = text(read(read(reason, "constructor"), "name"));
  if (className) extra.rejectionClass = className;
  for (const key of ["code", "type", "status", "statusText", "url"]) {
    const value = read(reason, key);
    if (typeof value === "number" && Number.isFinite(value)) extra[key] = value;
    else if (text(value)) extra[key] = text(value);
  }
  const target = read(reason, "target");
  const tag = text(read(target, "tagName"));
  if (tag) extra.resourceTag = tag;
  // Only resource elements have their address captured; never forms or inputs.
  if (
    tag &&
    ["SCRIPT", "LINK", "IMG", "SOURCE", "VIDEO", "AUDIO"].includes(
      tag.toUpperCase(),
    )
  ) {
    const url =
      text(read(target, "currentSrc")) ??
      text(read(target, "src")) ??
      text(read(target, "href"));
    if (url) extra.resourceUrl = url;
  }
  const description =
    message ??
    (typeof reason === "string"
      ? reason
      : reason === null ||
          (typeof reason !== "object" && typeof reason !== "function")
        ? String(reason)
        : `Unhandled promise rejection (${name ?? className ?? "object"}${extra.type ? `: ${extra.type}` : ""}${extra.status !== undefined ? `; status ${extra.status}` : ""})`);
  // Do not manufacture a capture-site stack when the source supplied none.
  const error = new Error(description);
  error.name = name ?? "UnhandledRejection";
  error.stack = stack;
  // Preserve the existing cause-chain behavior for cross-realm errors.
  const cause = read(reason, "cause");
  if (stack !== undefined && cause !== undefined) error.cause = cause;
  return { error, extra };
};
