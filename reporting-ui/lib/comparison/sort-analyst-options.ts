// A-Z ordering for analyst dropdown options: trimmed, case-insensitive,
// locale-aware; blank/unknown names ("", "—") go last.
const isBlank = (name: string): boolean => {
  const n = name.trim();
  return n === "" || n === "—";
};

export function sortAnalystOptionsAZ<T extends { name: string }>(
  options: readonly T[],
): T[] {
  return [...options].sort((a, b) => {
    const ab = isBlank(a.name);
    const bb = isBlank(b.name);
    if (ab !== bb) return ab ? 1 : -1;
    return a.name
      .trim()
      .localeCompare(b.name.trim(), undefined, { sensitivity: "base" });
  });
}
