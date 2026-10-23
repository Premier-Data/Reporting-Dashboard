import { supabase } from "@/lib/supabase";

// ======================================================================
// Simple username/password auth (UI-level only, no Supabase Auth).
// Passwords are SHA-256(salt + password) hashed. Not high-security; a
// lightweight gate to get role-based access running.
// ======================================================================

export type Role = "analyst" | "admin" | "super_admin";

export const ROLES: Role[] = ["analyst", "admin", "super_admin"];

export const ROLE_LABELS: Record<Role, string> = {
    analyst: "Analyst",
    admin: "Admin",
    super_admin: "Super Admin",
};

export interface UserAccount {
    id: number;
    created_at: string;
    username: string;
    analyst_name: string | null;
    email: string | null;
    role: Role;
}

// A row as stored (includes the hash/salt we never expose to the UI).
interface UserAccountRow extends UserAccount {
    password_hash: string;
    salt: string;
}

export interface RolePermission {
    role: Role;
    page_key: string;
    can_access: boolean;
}

// ----------------------------------------------------------------------
// Page registry — the pages the permission matrix can toggle. Keys match
// the seeded role_permissions.page_key values and (mostly) the route path.
// ----------------------------------------------------------------------
export interface PageDef {
    key: string;
    label: string;
    /** route path (for guard matching); omitted for virtual keys */
    href?: string;
}

export const PAGES: PageDef[] = [
    { key: "dashboard", label: "Dashboard", href: "/dashboard" },
    { key: "operations", label: "Live Board", href: "/operations" },
    { key: "computers", label: "Computers", href: "/computers" },
    { key: "downloads", label: "Downloads", href: "/downloads" },
    { key: "notifications", label: "Notifications", href: "/notifications" },
    { key: "live-scores", label: "Live Scores", href: "/live-scores" },
    { key: "fixtures", label: "Fixtures", href: "/fixtures" },
    { key: "comp-fixtures", label: "Comp Fixtures", href: "/comp-fixtures" },
    { key: "fixture-review", label: "Fixture Review", href: "/fixture-review" },
    { key: "competitions", label: "Competitions", href: "/competitions" },
    { key: "schedule", label: "Schedule", href: "/schedule" },
    { key: "recommendations", label: "AI Recommendations", href: "/recommendations" },
    { key: "analyst-management", label: "Analyst Management", href: "/analyst-management" },
    { key: "analyst-profile", label: "Analyst Profiles", href: "/analyst-profile" },
    { key: "affiliated-teams", label: "Affiliated Teams", href: "/affiliated-teams" },
    { key: "reporting", label: "Reporting", href: "/reporting" },
    { key: "board-report", label: "Board Report", href: "/board-report" },
    { key: "leaderboard", label: "Leaderboard", href: "/leaderboard" },
    { key: "analyst-compare", label: "Analyst Comparison", href: "/analyst-compare" },
    { key: "accuracy-compare", label: "Accuracy Comparison", href: "/accuracy-compare" },
    { key: "accuracy-fixture", label: "Fixture Accuracy", href: "/accuracy-fixture" },
    { key: "accuracy-checks", label: "Accuracy History", href: "/accuracy-checks" },
    { key: "settings", label: "Settings", href: "/settings" },
    { key: "disputes", label: "Disputes", href: "/disputes" },
    { key: "messages", label: "Messages", href: "/messages" },
    { key: "users", label: "User Accounts", href: "/users" },
    { key: "permissions", label: "Permissions", href: "/permissions" },
    { key: "admin-config", label: "Admin Configuration", href: "/admin-config" },
    { key: "competitors", label: "Competitor Intelligence", href: "/competitors" },
];

// Companion routes that share another page's access (no separate permission).
// Push Activity (/push-log) is a sub-view of Live Scores, so it inherits the
// "live-scores" permission rather than defining its own (which would default
// to denied for existing roles).
const PAGE_KEY_ALIASES: Record<string, string> = {
    "/push-log": "live-scores",
    // Player profiles are opened by clicking a player in the Live Scores team
    // lists, so they're a sub-view of Live Scores and inherit its permission
    // (rather than mapping to no key -> denied -> redirect to the dashboard).
    "/player": "live-scores",
};

/** Map a route pathname to its page key, or null if unknown. */
export function pageKeyForPath(pathname: string): string | null {
    // Longest href match wins (all hrefs are single-segment here).
    const seg = "/" + (pathname.split("/").filter(Boolean)[0] ?? "");
    if (PAGE_KEY_ALIASES[seg]) return PAGE_KEY_ALIASES[seg];
    const hit = PAGES.find((p) => p.href === seg);
    return hit?.key ?? null;
}

// ----------------------------------------------------------------------
// Password hashing (Web Crypto). SHA-256(salt + password) -> hex.
// ----------------------------------------------------------------------
export async function hashPassword(
    password: string,
    salt: string
): Promise<string> {
    const enc = new TextEncoder();
    const data = enc.encode(salt + password);

    // Prefer the Web Crypto API when available (secure contexts: HTTPS or
    // localhost). On plain-HTTP deployments `crypto.subtle` is undefined, so
    // fall back to a pure-JS SHA-256 that produces the identical digest.
    const subtle =
        typeof crypto !== "undefined" ? crypto.subtle : undefined;
    if (subtle) {
        const digest = await subtle.digest("SHA-256", data);
        return Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    }

    return sha256Hex(data);
}

// Pure-JS SHA-256 (FIPS 180-4). Used only when crypto.subtle is unavailable.
// Produces the same hex digest as Web Crypto so existing hashes still match.
function sha256Hex(message: Uint8Array): string {
    const K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
        0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
        0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
        0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
        0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];

    let h0 = 0x6a09e667,
        h1 = 0xbb67ae85,
        h2 = 0x3c6ef372,
        h3 = 0xa54ff53a,
        h4 = 0x510e527f,
        h5 = 0x9b05688c,
        h6 = 0x1f83d9ab,
        h7 = 0x5be0cd19;

    const l = message.length;
    const bitLen = l * 8;
    // Padded length: message + 0x80 + zeros + 8-byte length, multiple of 64.
    const withOne = l + 1;
    const k = (56 - (withOne % 64) + 64) % 64;
    const total = withOne + k + 8;
    const bytes = new Uint8Array(total);
    bytes.set(message);
    bytes[l] = 0x80;
    // 64-bit big-endian length (bit length fits in 32 bits for our inputs).
    const dv = new DataView(bytes.buffer);
    dv.setUint32(total - 4, bitLen >>> 0);
    dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000));

    const w = new Uint32Array(64);
    const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

    for (let off = 0; off < total; off += 64) {
        for (let i = 0; i < 16; i++) {
            w[i] = dv.getUint32(off + i * 4);
        }
        for (let i = 16; i < 64; i++) {
            const s0 =
                rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 =
                rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }

        let a = h0,
            b = h1,
            c = h2,
            d = h3,
            e = h4,
            f = h5,
            g = h6,
            h = h7;

        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + t1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) >>> 0;
        }

        h0 = (h0 + a) >>> 0;
        h1 = (h1 + b) >>> 0;
        h2 = (h2 + c) >>> 0;
        h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0;
        h5 = (h5 + f) >>> 0;
        h6 = (h6 + g) >>> 0;
        h7 = (h7 + h) >>> 0;
    }

    const toHex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
    return (
        toHex(h0) +
        toHex(h1) +
        toHex(h2) +
        toHex(h3) +
        toHex(h4) +
        toHex(h5) +
        toHex(h6) +
        toHex(h7)
    );
}

function randomSalt(): string {
    const bytes = new Uint8Array(12);
    // getRandomValues is also gated to secure contexts in some browsers;
    // fall back to Math.random (salt uniqueness, not cryptographic secrecy,
    // is what matters here for this lightweight scheme).
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = Math.floor(Math.random() * 256);
        }
    }
    return (
        "pd_" +
        Array.from(bytes)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")
    );
}

// ----------------------------------------------------------------------
// Auth
// ----------------------------------------------------------------------

/** Verify username + password; returns the account (sans secrets) or null. */
export async function login(
    username: string,
    password: string
): Promise<UserAccount | null> {
    const uname = username.trim();
    if (!uname) return null;

    const { data, error } = await supabase
        .from("user_accounts")
        .select("*")
        .ilike("username", uname)
        .limit(1)
        .maybeSingle();

    if (error) {
        console.error("Login lookup failed:", error);
        throw new Error(error.message || "Login failed");
    }
    if (!data) return null;

    const row = data as UserAccountRow;
    const hash = await hashPassword(password, row.salt);
    if (hash !== row.password_hash) return null;

    return {
        id: row.id,
        created_at: row.created_at,
        username: row.username,
        analyst_name: row.analyst_name,
        email: row.email ?? null,
        role: row.role,
    };
}

// ----------------------------------------------------------------------
// Account management (super-admin)
// ----------------------------------------------------------------------

export async function listUsers(): Promise<UserAccount[]> {
    const { data, error } = await supabase
        .from("user_accounts")
        .select("id, created_at, username, analyst_name, email, role")
        .order("username", { ascending: true });

    if (error) {
        console.error("Failed listing users:", error);
        throw new Error(error.message || "Failed listing users");
    }
    return (data ?? []) as UserAccount[];
}

export async function createUser(input: {
    username: string;
    password: string;
    analystName?: string | null;
    email?: string | null;
    role: Role;
}): Promise<UserAccount> {
    const username = input.username.trim();
    if (!username) throw new Error("Username is required.");
    if (!input.password) throw new Error("Password is required.");

    const salt = randomSalt();
    const password_hash = await hashPassword(input.password, salt);

    const { data, error } = await supabase
        .from("user_accounts")
        .insert({
            username,
            password_hash,
            salt,
            analyst_name: input.analystName?.trim() || null,
            email: input.email?.trim() || null,
            role: input.role,
        })
        .select("id, created_at, username, analyst_name, email, role")
        .single();

    if (error) {
        if (error.code === "23505") {
            throw new Error(`Username "${username}" already exists.`);
        }
        console.error("Failed creating user:", error);
        throw new Error(error.message || "Failed creating user");
    }
    return data as UserAccount;
}

export async function updateUserRole(id: number, role: Role): Promise<void> {
    const { error } = await supabase
        .from("user_accounts")
        .update({ role })
        .eq("id", id);
    if (error) {
        console.error("Failed updating role:", error);
        throw new Error(error.message || "Failed updating role");
    }
}

/**
 * Rename a user account. Trims the input, requires a non-empty value, and
 * surfaces the unique-constraint violation (code 23505) as a friendly message
 * — mirroring createUser's username handling so renames and creates enforce
 * the same rule.
 */
export async function updateUsername(id: number, username: string): Promise<void> {
    const next = username.trim();
    if (!next) throw new Error("Username is required.");
    const { error } = await supabase
        .from("user_accounts")
        .update({ username: next })
        .eq("id", id);
    if (error) {
        if (error.code === "23505") {
            throw new Error(`Username "${next}" already exists.`);
        }
        console.error("Failed updating username:", error);
        throw new Error(error.message || "Failed updating username");
    }
}

export async function resetUserPassword(
    id: number,
    newPassword: string
): Promise<void> {
    if (!newPassword) throw new Error("New password is required.");
    const salt = randomSalt();
    const password_hash = await hashPassword(newPassword, salt);
    const { error } = await supabase
        .from("user_accounts")
        .update({ password_hash, salt })
        .eq("id", id);
    if (error) {
        console.error("Failed resetting password:", error);
        throw new Error(error.message || "Failed resetting password");
    }
}

export async function deleteUser(id: number): Promise<void> {
    const { error } = await supabase
        .from("user_accounts")
        .delete()
        .eq("id", id);
    if (error) {
        console.error("Failed deleting user:", error);
        throw new Error(error.message || "Failed deleting user");
    }
}

// ----------------------------------------------------------------------
// Role permissions matrix
// ----------------------------------------------------------------------

export async function getRolePermissions(): Promise<RolePermission[]> {
    const { data, error } = await supabase
        .from("role_permissions")
        .select("role, page_key, can_access");
    if (error) {
        console.error("Failed loading role permissions:", error);
        throw new Error(error.message || "Failed loading permissions");
    }
    return (data ?? []) as RolePermission[];
}

export async function setRolePermission(
    role: Role,
    pageKey: string,
    canAccess: boolean
): Promise<void> {
    const { error } = await supabase
        .from("role_permissions")
        .upsert(
            { role, page_key: pageKey, can_access: canAccess },
            { onConflict: "role,page_key" }
        );
    if (error) {
        console.error("Failed setting permission:", error);
        throw new Error(error.message || "Failed setting permission");
    }
}

/** Build a nested lookup: permissions[role][pageKey] = boolean. */
export function buildPermissionMap(
    rows: RolePermission[]
): Record<string, Record<string, boolean>> {
    const map: Record<string, Record<string, boolean>> = {};
    for (const r of rows) {
        (map[r.role] ??= {})[r.page_key] = r.can_access;
    }
    return map;
}
