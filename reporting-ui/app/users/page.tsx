"use client";

import { useEffect, useState } from "react";
import { UserCog, Plus, Trash2, RotateCcw, Pencil, Check, X } from "lucide-react";
import {
    listUsers,
    createUser,
    updateUserRole,
    updateUsername,
    resetUserPassword,
    deleteUser,
    type UserAccount,
    type Role,
    ROLES,
    ROLE_LABELS,
} from "@/lib/api/auth";
import { getPlatformAnalystNames } from "@/lib/api/analysts";
import { provisionLmsUser } from "@/lib/api/lmsProvision";

export default function UsersPage() {
    const [users, setUsers] = useState<UserAccount[]>([]);
    const [analystNames, setAnalystNames] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);

    // Create form
    const [showCreate, setShowCreate] = useState(false);
    const [newUsername, setNewUsername] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [newAnalyst, setNewAnalyst] = useState("");
    const [newEmail, setNewEmail] = useState("");
    const [newRole, setNewRole] = useState<Role>("analyst");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);

    // Reset password
    const [resetId, setResetId] = useState<number | null>(null);
    const [resetPw, setResetPw] = useState("");

    // Inline username edit (which row is being renamed, and the draft value).
    const [editId, setEditId] = useState<number | null>(null);
    const [editUsername, setEditUsername] = useState("");
    const [savingName, setSavingName] = useState(false);

    async function load() {
        try {
            const [u, names] = await Promise.all([
                listUsers(),
                getPlatformAnalystNames(),
            ]);
            setUsers(u);
            setAnalystNames(names);
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        load();
    }, []);

    async function handleCreate() {
        setError(null);
        setMessage(null);
        if (!newUsername.trim()) {
            setError("Username is required.");
            return;
        }
        if (!newPassword) {
            setError("Password is required.");
            return;
        }
        try {
            setSaving(true);
            const email = newEmail.trim();
            await createUser({
                username: newUsername.trim(),
                password: newPassword,
                analystName: newAnalyst || null,
                email: email || null,
                role: newRole,
            });

            // Best-effort: if an email was given, provision (invite) the same
            // person into the LMS. Never block dashboard creation on this.
            let lmsNote = "";
            if (email) {
                const res = await provisionLmsUser({
                    email,
                    fullName: newAnalyst || newUsername.trim(),
                    role: newRole,
                });
                if (res.ok) {
                    lmsNote =
                        res.status === "exists"
                            ? " LMS account already existed (role synced)."
                            : " Invited to the LMS.";
                } else {
                    lmsNote = ` LMS provisioning failed: ${res.error}`;
                }
            }

            setMessage(`Created user "${newUsername.trim()}".${lmsNote}`);
            setNewUsername("");
            setNewPassword("");
            setNewAnalyst("");
            setNewEmail("");
            setNewRole("analyst");
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to create user.");
        } finally {
            setSaving(false);
        }
    }

    async function handleRoleChange(id: number, role: Role) {
        try {
            await updateUserRole(id, role);
            await load();
        } catch (err) {
            alert(err instanceof Error ? err.message : "Failed to update role.");
        }
    }

    function startEditUsername(u: UserAccount) {
        setEditId(u.id);
        setEditUsername(u.username);
    }

    function cancelEditUsername() {
        setEditId(null);
        setEditUsername("");
    }

    async function handleSaveUsername(id: number) {
        const next = editUsername.trim();
        if (!next) {
            alert("Username is required.");
            return;
        }
        setSavingName(true);
        try {
            await updateUsername(id, next);
            cancelEditUsername();
            await load();
        } catch (err) {
            alert(err instanceof Error ? err.message : "Failed to update username.");
        } finally {
            setSavingName(false);
        }
    }

    async function handleResetPassword(id: number) {
        if (!resetPw) return;
        try {
            await resetUserPassword(id, resetPw);
            setResetId(null);
            setResetPw("");
            alert("Password reset.");
        } catch (err) {
            alert(err instanceof Error ? err.message : "Failed to reset password.");
        }
    }

    async function handleDelete(id: number, username: string) {
        if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
        try {
            await deleteUser(id);
            await load();
        } catch (err) {
            alert(err instanceof Error ? err.message : "Failed to delete user.");
        }
    }

    if (loading) {
        return (
            <div className="min-h-full bg-slate-100 p-8 text-slate-600">
                Loading users...
            </div>
        );
    }

    return (
        <div className="min-h-full bg-slate-100 text-slate-900">
            <div className="mx-auto max-w-5xl p-6 lg:p-8">
                <div className="mb-6 flex items-center justify-between gap-4">
                    <div>
                        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight text-slate-900">
                            <UserCog size={26} /> User Accounts
                        </h1>
                        <p className="mt-2 text-sm text-slate-600">
                            Create and manage login accounts. Only super admins can access this page.
                        </p>
                    </div>
                    <button
                        onClick={() => setShowCreate(!showCreate)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
                    >
                        <Plus size={16} /> Create account
                    </button>
                </div>

                {/* Create form */}
                {showCreate && (
                    <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                        <h2 className="mb-4 text-sm font-semibold text-slate-700">
                            New user account
                        </h2>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            <div>
                                <label className="mb-1 block text-xs font-medium text-slate-500">
                                    Username
                                </label>
                                <input
                                    value={newUsername}
                                    onChange={(e) => setNewUsername(e.target.value)}
                                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                                    placeholder="e.g. coreyburl"
                                />
                            </div>
                            <div>
                                <label className="mb-1 block text-xs font-medium text-slate-500">
                                    Password
                                </label>
                                <input
                                    type="password"
                                    value={newPassword}
                                    onChange={(e) => setNewPassword(e.target.value)}
                                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                                    placeholder="initial password"
                                />
                            </div>
                            <div>
                                <label className="mb-1 block text-xs font-medium text-slate-500">
                                    Analyst name
                                </label>
                                <select
                                    value={newAnalyst}
                                    onChange={(e) => setNewAnalyst(e.target.value)}
                                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                                >
                                    <option value="">— none —</option>
                                    {analystNames.map((n) => (
                                        <option key={n} value={n}>{n}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="mb-1 block text-xs font-medium text-slate-500">
                                    Email{" "}
                                    <span className="font-normal text-slate-400">
                                        (invites them to the LMS)
                                    </span>
                                </label>
                                <input
                                    type="email"
                                    value={newEmail}
                                    onChange={(e) => setNewEmail(e.target.value)}
                                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                                    placeholder="name@premierdata.com.au"
                                />
                            </div>
                            <div>
                                <label className="mb-1 block text-xs font-medium text-slate-500">
                                    Role
                                </label>
                                <select
                                    value={newRole}
                                    onChange={(e) => setNewRole(e.target.value as Role)}
                                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                                >
                                    {ROLES.map((r) => (
                                        <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                        <div className="mt-4 flex items-center gap-3">
                            <button
                                onClick={handleCreate}
                                disabled={saving}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                            >
                                {saving ? "Creating..." : "Create"}
                            </button>
                            {error && (
                                <span className="text-sm text-red-600">{error}</span>
                            )}
                            {message && (
                                <span className="text-sm text-emerald-600">{message}</span>
                            )}
                        </div>
                    </div>
                )}

                {/* Users table */}
                <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                    <table className="min-w-full text-sm">
                        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                            <tr>
                                <th className="px-4 py-3">Username</th>
                                <th className="px-4 py-3">Analyst name</th>
                                <th className="px-4 py-3">Role</th>
                                <th className="px-4 py-3">Created</th>
                                <th className="px-4 py-3"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {users.map((u) => (
                                <tr
                                    key={u.id}
                                    className="border-t border-slate-100 hover:bg-slate-50"
                                >
                                    <td className="px-4 py-3 font-medium text-slate-800">
                                        {editId === u.id ? (
                                            <div className="flex items-center gap-1.5">
                                                <input
                                                    value={editUsername}
                                                    onChange={(e) =>
                                                        setEditUsername(e.target.value)
                                                    }
                                                    onKeyDown={(e) => {
                                                        if (e.key === "Enter")
                                                            handleSaveUsername(u.id);
                                                        if (e.key === "Escape")
                                                            cancelEditUsername();
                                                    }}
                                                    autoFocus
                                                    disabled={savingName}
                                                    className="w-40 rounded-lg border border-slate-300 px-2 py-1 text-sm outline-none focus:border-blue-500"
                                                />
                                                <button
                                                    onClick={() => handleSaveUsername(u.id)}
                                                    disabled={savingName}
                                                    className="rounded p-1.5 text-slate-400 hover:bg-emerald-50 hover:text-emerald-600 disabled:opacity-40"
                                                    title="Save username"
                                                >
                                                    <Check size={15} />
                                                </button>
                                                <button
                                                    onClick={cancelEditUsername}
                                                    disabled={savingName}
                                                    className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40"
                                                    title="Cancel"
                                                >
                                                    <X size={15} />
                                                </button>
                                            </div>
                                        ) : (
                                            <div className="group flex items-center gap-1.5">
                                                <span>{u.username}</span>
                                                <button
                                                    onClick={() => startEditUsername(u)}
                                                    className="rounded p-1 text-slate-300 opacity-0 transition hover:bg-blue-50 hover:text-blue-600 group-hover:opacity-100"
                                                    title="Edit username"
                                                >
                                                    <Pencil size={13} />
                                                </button>
                                            </div>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-slate-600">
                                        {u.analyst_name || "—"}
                                    </td>
                                    <td className="px-4 py-3">
                                        <select
                                            value={u.role}
                                            onChange={(e) =>
                                                handleRoleChange(u.id, e.target.value as Role)
                                            }
                                            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-medium outline-none focus:border-blue-500"
                                        >
                                            {ROLES.map((r) => (
                                                <option key={r} value={r}>
                                                    {ROLE_LABELS[r]}
                                                </option>
                                            ))}
                                        </select>
                                    </td>
                                    <td className="px-4 py-3 text-slate-500">
                                        {new Date(u.created_at).toLocaleDateString("en-AU", {
                                            day: "2-digit",
                                            month: "short",
                                            year: "numeric",
                                        })}
                                    </td>
                                    <td className="px-4 py-3">
                                        <div className="flex items-center gap-1">
                                            {resetId === u.id ? (
                                                <div className="flex items-center gap-1">
                                                    <input
                                                        type="password"
                                                        value={resetPw}
                                                        onChange={(e) => setResetPw(e.target.value)}
                                                        placeholder="new password"
                                                        className="w-28 rounded border border-slate-300 px-2 py-1 text-xs outline-none"
                                                    />
                                                    <button
                                                        onClick={() => handleResetPassword(u.id)}
                                                        className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
                                                    >
                                                        Save
                                                    </button>
                                                    <button
                                                        onClick={() => {
                                                            setResetId(null);
                                                            setResetPw("");
                                                        }}
                                                        className="rounded bg-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-300"
                                                    >
                                                        Cancel
                                                    </button>
                                                </div>
                                            ) : (
                                                <button
                                                    onClick={() => setResetId(u.id)}
                                                    className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-blue-600"
                                                    title="Reset password"
                                                >
                                                    <RotateCcw size={14} />
                                                </button>
                                            )}
                                            <button
                                                onClick={() => handleDelete(u.id, u.username)}
                                                className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                                                title="Delete user"
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                            {users.length === 0 && (
                                <tr>
                                    <td
                                        colSpan={5}
                                        className="px-4 py-8 text-center text-slate-400"
                                    >
                                        No accounts yet.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
