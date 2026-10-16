import { supabase } from "@/lib/supabase";

// ======================================================================
// Direct messaging between users (admins <-> analysts), e.g. about
// disputes/flags feedback. Mirrors the LMS platform's messaging feature,
// adapted to this app's lightweight auth: participants are user_accounts.id
// (numeric), there's no Supabase Auth / RLS, so the "current user" is passed
// in by callers from useAuth().
// ======================================================================

export type ConversationType = "direct" | "group";

/** A conversation row (mirrors the conversations table). */
export interface ConversationRow {
    id: number;
    created_at: string;
    type: ConversationType;
    title: string | null;
    created_by: number | null;
    dispute_id: number | null;
    check_id: number | null;
}

/** Kind of file attached to a message. */
export type AttachmentType = "image" | "video" | "document";

/** A message row (mirrors the messages table). */
export interface MessageRow {
    id: number;
    created_at: string;
    conversation_id: number;
    sender_id: number;
    content: string | null;
    attachment_url: string | null;
    attachment_name: string | null;
    attachment_type: AttachmentType | null;
}

/** An uploaded attachment, ready to attach to a message. */
export interface Attachment {
    url: string;
    name: string;
    type: AttachmentType;
}

const ATTACHMENT_BUCKET = "message-attachments";

// ----------------------------------------------------------------------
// Unread-count refresh signal (pure, Supabase-free).
//
// The sidebar badge subscribes ONCE per user (see Sidebar.tsx) and no longer
// refetches on every navigation. To keep "clears after read" working without a
// per-nav poll, read actions fire this lightweight in-process event; listeners
// (the badge) re-run their own getUnreadCount. No new deps, no Supabase traffic
// — this is the explicit refresh trigger that replaces the pathname refetch.
// ----------------------------------------------------------------------
const unreadListeners = new Set<() => void>();

/**
 * Subscribe to "unread count may have changed" notifications. Returns an
 * unsubscribe function. Used by the sidebar badge to refresh after a read.
 */
export function onUnreadShouldRefresh(cb: () => void): () => void {
    unreadListeners.add(cb);
    return () => {
        unreadListeners.delete(cb);
    };
}

/** Fire all unread-refresh listeners (e.g. after marking a conversation read). */
export function notifyUnreadChanged(): void {
    for (const cb of unreadListeners) {
        try {
            cb();
        } catch {
            // A single bad listener must not break the others.
        }
    }
}

/** Classify a file's MIME type into our attachment kind. */
export function attachmentTypeFor(mime: string): AttachmentType {
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    return "document";
}

/**
 * Upload a file to the public message-attachments bucket and return its public
 * URL + display name + kind. Runs client-side with the anon key (no API route).
 * Keys are namespaced by conversation and made unique with a timestamp + random
 * suffix so same-named files never collide.
 */
export async function uploadAttachment(
    conversationId: number,
    file: File
): Promise<Attachment> {
    const safeName = file.name.replace(/[^\w.\-]+/g, "_");
    const key = `${conversationId}/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}-${safeName}`;

    const { error } = await supabase.storage
        .from(ATTACHMENT_BUCKET)
        .upload(key, file, {
            contentType: file.type || "application/octet-stream",
            upsert: false,
        });
    if (error) {
        console.error("Failed uploading attachment:", error);
        throw new Error(error.message || "Failed uploading file");
    }

    const { data } = supabase.storage
        .from(ATTACHMENT_BUCKET)
        .getPublicUrl(key);

    return {
        url: data.publicUrl,
        name: file.name,
        type: attachmentTypeFor(file.type),
    };
}

/** A member of a conversation, with a display name resolved from the account. */
export interface ConversationMember {
    userId: number;
    name: string;
}

/** A conversation as shown in the inbox list. */
export interface ConversationSummary {
    id: number;
    type: ConversationType;
    title: string | null;
    /** Name to show (the other person for direct, the title for a group). */
    displayName: string;
    members: ConversationMember[];
    disputeId: number | null;
    checkId: number | null;
    lastMessage: {
        content: string | null;
        attachmentName: string | null;
        createdAt: string;
        senderId: number;
    } | null;
    /** Unread messages for the current user in this conversation. */
    unread: number;
}

/** A message enriched for display (sender name + is-mine flag). */
export interface DisplayMessage extends MessageRow {
    senderName: string;
    isMine: boolean;
}

// A lightweight account descriptor for resolving member names / the recipient
// picker. Matches the fields we read from user_accounts.
export interface MessageUser {
    id: number;
    username: string;
    analystName: string | null;
    role: string;
}

/** Best display name for an account: analyst name, else username. */
function accountName(u: MessageUser | undefined): string {
    if (!u) return "User";
    return (u.analystName?.trim() || u.username || "User").trim();
}

/**
 * Find the user account for a given analyst name (case-insensitive match on
 * analyst_name, then username). Returns null when no account matches — e.g. an
 * analyst who was graded but has no login account.
 */
export async function findUserByAnalystName(
    analystName: string
): Promise<MessageUser | null> {
    const name = analystName.trim().toLowerCase();
    if (!name) return null;
    const users = await getMessageUsers();
    return (
        users.find((u) => (u.analystName ?? "").trim().toLowerCase() === name) ??
        users.find((u) => u.username.trim().toLowerCase() === name) ??
        null
    );
}

/**
 * All app accounts, for resolving member names and populating the recipient
 * picker. Mirrors auth.listUsers but kept here so messaging is self-contained.
 */
export async function getMessageUsers(): Promise<MessageUser[]> {
    const { data, error } = await supabase
        .from("user_accounts")
        .select("id, username, analyst_name, role")
        .order("username", { ascending: true });
    if (error) {
        console.error("Failed loading message users:", error);
        throw new Error(error.message || "Failed loading users");
    }
    return (data ?? []).map((r) => {
        const row = r as {
            id: number;
            username: string;
            analyst_name: string | null;
            role: string;
        };
        return {
            id: row.id,
            username: row.username,
            analystName: row.analyst_name,
            role: row.role,
        };
    });
}

/**
 * List the current user's conversations with their other members, last
 * message, and unread count — newest activity first. Aggregation is done in JS
 * (matching getOpenDisputeCounts) since RLS is off and there's no auth.uid().
 */
export async function getConversationsForUser(
    userId: number
): Promise<ConversationSummary[]> {
    // Which conversations this user belongs to + their read watermark.
    const { data: memberships, error: memErr } = await supabase
        .from("conversation_members")
        .select("conversation_id, last_read_at")
        .eq("user_id", userId);
    if (memErr) {
        console.error("Failed loading memberships:", memErr);
        throw new Error(memErr.message || "Failed loading conversations");
    }
    const convIds = (memberships ?? []).map(
        (m) => (m as { conversation_id: number }).conversation_id
    );
    if (convIds.length === 0) return [];

    const lastReadMap = new Map<number, string | null>(
        (memberships ?? []).map((m) => {
            const row = m as {
                conversation_id: number;
                last_read_at: string | null;
            };
            return [row.conversation_id, row.last_read_at];
        })
    );

    const [convsRes, membersRes, msgsRes, users] = await Promise.all([
        supabase
            .from("conversations")
            .select("id, created_at, type, title, created_by, dispute_id, check_id")
            .in("id", convIds),
        supabase
            .from("conversation_members")
            .select("conversation_id, user_id")
            .in("conversation_id", convIds),
        supabase
            .from("messages")
            .select(
                "id, conversation_id, sender_id, content, attachment_url, attachment_name, attachment_type, created_at"
            )
            .in("conversation_id", convIds)
            .order("created_at", { ascending: false }),
        getMessageUsers(),
    ]);

    if (convsRes.error) {
        console.error("Failed loading conversations:", convsRes.error);
        throw new Error(convsRes.error.message || "Failed loading conversations");
    }

    const userById = new Map(users.map((u) => [u.id, u]));
    const conversations = (convsRes.data ?? []) as ConversationRow[];
    const allMembers = (membersRes.data ?? []) as {
        conversation_id: number;
        user_id: number;
    }[];
    const allMessages = (msgsRes.data ?? []) as MessageRow[];

    const result: ConversationSummary[] = conversations.map((conv) => {
        const members: ConversationMember[] = allMembers
            .filter((m) => m.conversation_id === conv.id)
            .map((m) => ({
                userId: m.user_id,
                name: accountName(userById.get(m.user_id)),
            }));

        const convMessages = allMessages.filter(
            (m) => m.conversation_id === conv.id
        );
        const last = convMessages[0] ?? null; // messages are desc

        const lastRead = lastReadMap.get(conv.id);
        const unread = convMessages.filter(
            (m) =>
                m.sender_id !== userId &&
                (!lastRead || new Date(m.created_at) > new Date(lastRead))
        ).length;

        const others = members.filter((m) => m.userId !== userId);
        const displayName =
            conv.type === "group"
                ? conv.title || "Group"
                : others[0]?.name || "Conversation";

        return {
            id: conv.id,
            type: conv.type,
            title: conv.title,
            displayName,
            members,
            disputeId: conv.dispute_id,
            checkId: conv.check_id,
            lastMessage: last
                ? {
                      content: last.content,
                      attachmentName: last.attachment_name,
                      createdAt: last.created_at,
                      senderId: last.sender_id,
                  }
                : null,
            unread,
        };
    });

    // Most recent activity first (fall back to conversation creation time).
    result.sort((a, b) => {
        const at = a.lastMessage?.createdAt ?? "";
        const bt = b.lastMessage?.createdAt ?? "";
        return bt.localeCompare(at);
    });
    return result;
}

/**
 * Find the existing 1:1 direct conversation between two users, or create one.
 * Optionally link it to a dispute/check (for "message about this flag").
 * Returns the conversation id.
 */
export async function getOrCreateDirectConversation(
    userId: number,
    targetUserId: number,
    link?: { disputeId?: number | null; checkId?: number | null }
): Promise<number> {
    if (userId === targetUserId) {
        throw new Error("Cannot start a conversation with yourself.");
    }

    // Reuse an existing direct conversation between these two, if any.
    const { data: mine } = await supabase
        .from("conversation_members")
        .select("conversation_id")
        .eq("user_id", userId);
    const myIds = (mine ?? []).map(
        (m) => (m as { conversation_id: number }).conversation_id
    );

    if (myIds.length > 0) {
        const { data: shared } = await supabase
            .from("conversation_members")
            .select("conversation_id, conversations!inner(type)")
            .eq("user_id", targetUserId)
            .in("conversation_id", myIds);
        const existing = (shared ?? []).find(
            (s) =>
                (s as unknown as { conversations: { type: string } })
                    .conversations?.type === "direct"
        );
        if (existing) {
            return (existing as { conversation_id: number }).conversation_id;
        }
    }

    const { data: conv, error } = await supabase
        .from("conversations")
        .insert({
            type: "direct",
            created_by: userId,
            dispute_id: link?.disputeId ?? null,
            check_id: link?.checkId ?? null,
        })
        .select("id")
        .single();
    if (error || !conv) {
        console.error("Failed creating conversation:", error);
        throw new Error(error?.message || "Failed creating conversation");
    }
    const conversationId = (conv as { id: number }).id;

    const { error: memErr } = await supabase
        .from("conversation_members")
        .insert([
            { conversation_id: conversationId, user_id: userId },
            { conversation_id: conversationId, user_id: targetUserId },
        ]);
    if (memErr) {
        console.error("Failed adding members:", memErr);
        throw new Error(memErr.message || "Failed creating conversation");
    }

    return conversationId;
}

/**
 * Create a group conversation with a title and a set of members (the creator
 * is always included). Returns the new conversation id. Admin-gated by the
 * caller — the API layer just writes the rows.
 */
export async function createGroupConversation(
    creatorId: number,
    title: string,
    memberIds: number[]
): Promise<number> {
    const cleanTitle = title.trim();
    if (!cleanTitle) throw new Error("Group name is required.");
    const members = Array.from(new Set([creatorId, ...memberIds]));
    if (members.length < 2) {
        throw new Error("Add at least one other member.");
    }

    const { data: conv, error } = await supabase
        .from("conversations")
        .insert({ type: "group", title: cleanTitle, created_by: creatorId })
        .select("id")
        .single();
    if (error || !conv) {
        console.error("Failed creating group:", error);
        throw new Error(error?.message || "Failed creating group");
    }
    const conversationId = (conv as { id: number }).id;

    const { error: memErr } = await supabase
        .from("conversation_members")
        .insert(
            members.map((uid) => ({
                conversation_id: conversationId,
                user_id: uid,
            }))
        );
    if (memErr) {
        console.error("Failed adding group members:", memErr);
        throw new Error(memErr.message || "Failed creating group");
    }

    return conversationId;
}

/**
 * Messages for a conversation (oldest first), enriched with sender name and an
 * is-mine flag. Also marks the conversation read for the current user.
 */
export async function getMessages(
    conversationId: number,
    userId: number
): Promise<DisplayMessage[]> {
    const [msgsRes, users] = await Promise.all([
        supabase
            .from("messages")
            .select(
                "id, created_at, conversation_id, sender_id, content, attachment_url, attachment_name, attachment_type"
            )
            .eq("conversation_id", conversationId)
            .order("created_at", { ascending: true }),
        getMessageUsers(),
    ]);
    if (msgsRes.error) {
        console.error("Failed loading messages:", msgsRes.error);
        throw new Error(msgsRes.error.message || "Failed loading messages");
    }
    const userById = new Map(users.map((u) => [u.id, u]));
    const messages = (msgsRes.data ?? []) as MessageRow[];

    // Mark read (best-effort; don't fail the load if this errors).
    await markConversationRead(conversationId, userId).catch(() => {});

    return messages.map((m) => ({
        ...m,
        senderName: accountName(userById.get(m.sender_id)),
        isMine: m.sender_id === userId,
    }));
}

/**
 * Send a message with optional text and/or a file attachment. At least one of
 * the two must be present. Returns the inserted row.
 */
export async function sendMessage(
    conversationId: number,
    senderId: number,
    content: string,
    attachment?: Attachment | null
): Promise<MessageRow> {
    const text = content.trim();
    if (!text && !attachment) throw new Error("Message is empty.");
    const { data, error } = await supabase
        .from("messages")
        .insert({
            conversation_id: conversationId,
            sender_id: senderId,
            content: text || null,
            attachment_url: attachment?.url ?? null,
            attachment_name: attachment?.name ?? null,
            attachment_type: attachment?.type ?? null,
        })
        .select(
            "id, created_at, conversation_id, sender_id, content, attachment_url, attachment_name, attachment_type"
        )
        .single();
    if (error || !data) {
        console.error("Failed sending message:", error);
        throw new Error(error?.message || "Failed sending message");
    }
    return data as MessageRow;
}

/** Update the current user's last_read_at for a conversation to now. */
export async function markConversationRead(
    conversationId: number,
    userId: number
): Promise<void> {
    const { error } = await supabase
        .from("conversation_members")
        .update({ last_read_at: new Date().toISOString() })
        .eq("conversation_id", conversationId)
        .eq("user_id", userId);
    if (error) {
        console.error("Failed marking conversation read:", error);
        throw new Error(error.message || "Failed marking read");
    }
    // Read watermark moved → the sidebar badge should drop to the new count.
    // This replaces the old per-navigation refetch (Sidebar now subscribes
    // once per user and listens for this signal).
    notifyUnreadChanged();
}

/**
 * Total unread messages across all the user's conversations (for the sidebar
 * badge). Aggregated in JS, same approach as getConversationsForUser.
 */
export async function getUnreadCount(userId: number): Promise<number> {
    const { data: memberships, error } = await supabase
        .from("conversation_members")
        .select("conversation_id, last_read_at")
        .eq("user_id", userId);
    if (error) {
        console.error("Failed loading unread count:", error);
        return 0;
    }
    const convIds = (memberships ?? []).map(
        (m) => (m as { conversation_id: number }).conversation_id
    );
    if (convIds.length === 0) return 0;
    const lastReadMap = new Map<number, string | null>(
        (memberships ?? []).map((m) => {
            const row = m as {
                conversation_id: number;
                last_read_at: string | null;
            };
            return [row.conversation_id, row.last_read_at];
        })
    );

    const { data: messages } = await supabase
        .from("messages")
        .select("conversation_id, sender_id, created_at")
        .in("conversation_id", convIds);

    return ((messages ?? []) as MessageRow[]).filter((m) => {
        if (m.sender_id === userId) return false;
        const lastRead = lastReadMap.get(m.conversation_id);
        return !lastRead || new Date(m.created_at) > new Date(lastRead);
    }).length;
}

/**
 * Subscribe to new messages in a conversation via Supabase Realtime. Fires
 * `onInsert` with each new message row. Returns an unsubscribe function.
 * Follows the subscribeToAccuracyCheck pattern; requires Realtime enabled for
 * the `messages` table (degrades gracefully to no live updates otherwise).
 */
export function subscribeToConversation(
    conversationId: number,
    onInsert: (message: MessageRow) => void
): () => void {
    // Unique channel name per call — same reason as subscribeToAllMessages:
    // the /messages page and the floating chat widget could both open the same
    // conversation, and a shared name would throw on the second subscriber.
    const channelName = `messages_${conversationId}_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
    const channel = supabase
        .channel(channelName)
        .on(
            "postgres_changes",
            {
                event: "INSERT",
                schema: "public",
                table: "messages",
                filter: `conversation_id=eq.${conversationId}`,
            },
            (payload) => onInsert(payload.new as MessageRow)
        )
        .subscribe();
    return () => {
        supabase.removeChannel(channel);
    };
}

/**
 * Subscribe to ALL new messages (any conversation) so the inbox / unread badge
 * can refresh live. Coarse but simple; the callback should re-fetch counts.
 *
 * Each call gets a UNIQUE channel name. Supabase permits only one channel per
 * name per client and rejects adding `.on()` handlers to a name that's already
 * been `.subscribe()`d — so a shared "messages_all" name would throw the moment
 * a second consumer mounts (e.g. the sidebar badge AND the floating chat
 * widget). The unique suffix lets any number of consumers subscribe safely.
 */
export function subscribeToAllMessages(onInsert: () => void): () => void {
    const channelName = `messages_all_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
    const channel = supabase
        .channel(channelName)
        .on(
            "postgres_changes",
            { event: "INSERT", schema: "public", table: "messages" },
            () => onInsert()
        )
        .subscribe();
    return () => {
        supabase.removeChannel(channel);
    };
}
