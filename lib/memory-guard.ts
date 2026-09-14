// lib/memory-guard.ts
// SullyOS-inspired memory purity guards and decay / eviction algorithms.

import type { MemoryEntry } from "./memory-types";

/**
 * Clean thinking / reasoning residues and meta-prompt artifacts from summary text.
 */
export function sanitizeMemorySummary(raw: string): string {
    if (!raw) return "";

    let text = raw;

    // 1. Strip <think>...</think> or similar reasoning tags
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
    text = text.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");

    // 2. Remove common meta-commentary prefaces
    const metaPrefixPatterns = [
        /^(根据|基于)(以上|上述|提供的)(事件|对话|记录|内容)[，,、\s]*?(以下是|为您总结如下|总结如下)[：:\s]*/i,
        /^(以下是|为您生成|生成总结)[：:\s]*/i,
        /^(总结如下|事实总结)[：:\s]*/i,
        /^【(?:核心记忆|记忆总结|事实性总结)】[：:\s]*/i,
    ];
    for (const pattern of metaPrefixPatterns) {
        text = text.replace(pattern, "");
    }

    // 3. Remove trailing word count or verification notes
    const metaSuffixPatterns = [
        /(?:[\r\n]+|^)(?:注|字数统计|字数|说明)[：:\s]*\d+.*$/gim,
        /(?:[\r\n]+|^)(?:本总结|以上内容)符合.+要求.*$/gim,
    ];
    for (const pattern of metaSuffixPatterns) {
        text = text.replace(pattern, "");
    }

    return text.trim();
}

/**
 * Check whether a generated memory summary is contaminated with reasoning or formatting leaks.
 */
export function isSummaryContaminated(text: string): boolean {
    if (!text || text.trim().length === 0) return true;

    // Reject leaked thinking tags
    if (/<\/?(think|thought|reasoning)>/i.test(text)) return true;

    // Reject meta instructions leaking into prompt
    const suspiciousPhrases = [
        "不要使用 JSON",
        "不要包含格式标记",
        "用第三人称描述",
        "时间跨度：",
        "事件记录：",
        "要求：",
        "字数统计",
    ];
    for (const phrase of suspiciousPhrases) {
        if (text.includes(phrase)) return true;
    }

    return false;
}

/**
 * Calculate effective importance under hourly time decay.
 * Formula: Importance * (DecayRate ^ hoursElapsed)
 */
export function computeEffectiveImportance(
    entry: MemoryEntry,
    decayRatePerHour: number = 0.995,
    nowMs: number = Date.now()
): number {
    const baseImportance = typeof entry.importance === "number" ? entry.importance : 0.8;
    const refTime = entry.lastAccessedAt
        ? new Date(entry.lastAccessedAt).getTime()
        : new Date(entry.updatedAt || entry.createdAt).getTime();

    if (isNaN(refTime)) return baseImportance;

    const hoursElapsed = Math.max(0, (nowMs - refTime) / (1000 * 60 * 60));
    return baseImportance * Math.pow(decayRatePerHour, hoursElapsed);
}

/**
 * SullyOS Room Eviction:
 * Partition entries into living_room and attic.
 * If living_room entries exceed limit, demote lowest effective importance entries to attic.
 */
export function evictLivingRoomEntries(
    entries: MemoryEntry[],
    maxLivingRoom: number = 200,
    decayRatePerHour: number = 0.995
): { updatedEntries: MemoryEntry[]; demotedCount: number } {
    const livingRoom: MemoryEntry[] = [];
    const attic: MemoryEntry[] = [];

    for (const entry of entries) {
        if (entry.room === "attic") {
            attic.push(entry);
        } else {
            livingRoom.push(entry);
        }
    }

    if (livingRoom.length <= maxLivingRoom) {
        return { updatedEntries: entries, demotedCount: 0 };
    }

    const now = Date.now();
    // Sort ascending by effective importance (lowest first)
    const scored = livingRoom.map(e => ({
        entry: e,
        score: computeEffectiveImportance(e, decayRatePerHour, now),
    }));
    scored.sort((a, b) => a.score - b.score);

    const demoteCount = livingRoom.length - maxLivingRoom;
    const demotedIds = new Set(scored.slice(0, demoteCount).map(s => s.entry.id));

    const updatedEntries = entries.map(e => {
        if (demotedIds.has(e.id)) {
            return {
                ...e,
                room: "attic" as const,
                updatedAt: new Date().toISOString(),
            };
        }
        return e;
    });

    return { updatedEntries, demotedCount: demoteCount };
}
