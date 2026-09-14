// lib/short-term-deleter.ts
// Deletion router for native short-term events in the Memory Timeline.

import { deleteChatMessage } from "./chat-storage";
import { kvGet, kvSet } from "./kv-db";
import type { NativeTimelineEntry } from "./short-term-assembler";

export async function deleteNativeTimelineEntry(
    entry: NativeTimelineEntry,
    characterId: string
): Promise<{ success: boolean; error?: string }> {
    try {
        switch (entry.sourceApp) {
            case "chat":
            case "group_chat": {
                if (entry.sourceId) {
                    await deleteChatMessage(entry.sourceId);
                    return { success: true };
                }
                return { success: false, error: "缺少消息 ID" };
            }

            case "moments": {
                if (typeof window !== "undefined" && entry.sourceId) {
                    try {
                        const { openIndexedDbAtLeast } = await import("./idb-open");
                        const db = await openIndexedDbAtLeast("AiPhoneMomentsDB", 1, () => {});
                        if (db) {
                            const tx = db.transaction(["posts", "comments"], "readwrite");
                            tx.objectStore("posts").delete(entry.sourceId);
                            tx.objectStore("comments").delete(entry.sourceId);
                            await new Promise<void>((res) => {
                                tx.oncomplete = () => res();
                                tx.onerror = () => res();
                            });
                            db.close();
                        }
                    } catch { /* ignore */ }
                }
                return { success: true };
            }

            case "diary": {
                if (typeof window !== "undefined") {
                    const raw = kvGet("ai_phone_diary_entries_v1");
                    if (raw) {
                        try {
                            const list = JSON.parse(raw);
                            if (Array.isArray(list)) {
                                const next = list.filter((d: any) => d.id !== entry.sourceId);
                                kvSet("ai_phone_diary_entries_v1", JSON.stringify(next));
                            }
                        } catch { /* ignore */ }
                    }
                }
                return { success: true };
            }

            case "xiaohongshu": {
                deletePrefixArrayItem("ai_phone_xiaohongshu_events_", characterId, entry.id);
                return { success: true };
            }

            case "interview_magazine": {
                deletePrefixArrayItem("ai_phone_interview_magazine_events_", characterId, entry.id);
                return { success: true };
            }

            case "cocreate": {
                deletePrefixArrayItem("ai_phone_cocreate_events_", characterId, entry.id);
                return { success: true };
            }

            case "custom_app": {
                deletePrefixArrayItem("ai_phone_notewall_events_", characterId, entry.id);
                deletePrefixArrayItem("note_wall_events_", characterId, entry.id);
                return { success: true };
            }

            default: {
                deletePrefixArrayItem("ai_phone_notewall_events_", characterId, entry.id);
                return { success: true };
            }
        }
    } catch (err) {
        return { success: false, error: String(err) };
    }
}

function deletePrefixArrayItem(prefix: string, characterId: string, entryId: string) {
    if (typeof window === "undefined") return;
    const key = `${prefix}${characterId}`;
    const raw = kvGet(key);
    if (!raw) return;
    try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
            const next = arr.filter((item: any) => item.id !== entryId && `proj_${item.id}` !== entryId);
            kvSet(key, JSON.stringify(next));
        }
    } catch { /* ignore */ }
}
