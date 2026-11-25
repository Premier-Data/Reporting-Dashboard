// Pure Deputy HTTP guard for gameface-deputy-sync (no Deno imports).
//
// buildQueryUrl is the ONLY place a Deputy URL is built. It can only produce
// `<base>/resource/<Name>/QUERY` for the six read resources, so there is no
// path to create, edit, delete or approve anything in the second company's
// Deputy account. validateBaseUrl stops the API token being sent to any host
// other than a *.deputy.com install.

const ALLOWED_RESOURCES = [
  "Company",
  "OperationalUnit",
  "Employee",
  "Roster",
  "Timesheet",
  "Leave",
] as const;

/** Returns the normalised `https://<host>.deputy.com/api/v1`, or null. */
export function validateBaseUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (u.search || u.hash || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!host.endsWith(".deputy.com") || host.length <= ".deputy.com".length) return null;
  if (u.pathname !== "/api/v1" && u.pathname !== "/api/v1/") return null;
  return `https://${host}/api/v1`;
}

/** The QUERY URL for one allowed resource. Throws for anything else. */
export function buildQueryUrl(base: string, resource: string): string {
  const safeBase = validateBaseUrl(base);
  if (!safeBase) throw new Error("invalid_base_url");
  if (!(ALLOWED_RESOURCES as readonly string[]).includes(resource)) {
    throw new Error("resource_not_allowed");
  }
  return `${safeBase}/resource/${resource}/QUERY`;
}
