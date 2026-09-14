// lib/event-box-service.ts
// SullyOS-inspired EventBox management and aggregation service.

import type { EventBox, MemoryEntry } from "./memory-types";
import { sanitizeMemorySummary } from "./memory-guard";
import { kvGet, kvSet, registerDynamicPrefix } from "./kv-db";

const EVENT_BOX_KEY_PREFIX = "aivp_event_boxes_";

// EventBox 必须走 kv-db（IndexedDB）：备份/导入/清空的数据源只读 AiPhoneKvDB，
// 直接写 localStorage 的事件箱既不进备份、也清不掉、导不回来（数据管理 → 记忆
// 模块里那条 aivp_event_boxes_ 前缀会永远是空的）。注册前缀让老设备的
// localStorage 数据自动迁进来，不丢档。
registerDynamicPrefix(EVENT_BOX_KEY_PREFIX);

/** 事件箱摘要上限：新建首条与增量追加共用同一口径 */
const SUMMARY_MAX_LENGTH = 500;

function capSummary(text: string): string {
    return text.length > SUMMARY_MAX_LENGTH
        ? `${text.slice(0, SUMMARY_MAX_LENGTH - 3)}...`
        : text;
}

export function loadEventBoxes(characterId: string): EventBox[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(`${EVENT_BOX_KEY_PREFIX}${characterId}`);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

export function saveEventBoxes(characterId: string, boxes: EventBox[]): void {
    if (typeof window === "undefined") return;
    try {
        kvSet(`${EVENT_BOX_KEY_PREFIX}${characterId}`, JSON.stringify(boxes));
    } catch (err) {
        console.error("[EventBoxService] Failed to save event boxes:", err);
    }
}

export function getActiveEventBox(characterId: string): EventBox | null {
    const boxes = loadEventBoxes(characterId);
    return boxes.find(b => b.status === "active") || null;
}

/**
 * Ingests a new memory entry into an active EventBox.
 * Creates a new active EventBox if none exists.
 * Seals the box if member count exceeds maxLimit (default 12).
 */
export function ingestEntryToEventBox(
    characterId: string,
    entry: MemoryEntry,
    options?: { maxEvents?: number }
): { box: EventBox; sealed: boolean } {
    const maxEvents = options?.maxEvents ?? 12;
    const boxes = loadEventBoxes(characterId);
    let activeBox = boxes.find(b => b.status === "active");

    const now = new Date().toISOString();

    if (!activeBox) {
        activeBox = {
            id: `box_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            characterId,
            title: `事件片段 ${new Date().toLocaleDateString()}`,
            tags: ["日常"],
            status: "active",
            summary: capSummary(sanitizeMemorySummary(entry.content)),
            memberEntryIds: [entry.id],
            eventCount: 1,
            createdAt: now,
            updatedAt: now,
        };
        boxes.unshift(activeBox);
    } else {
        activeBox.memberEntryIds.push(entry.id);
        activeBox.eventCount += 1;
        activeBox.updatedAt = now;
        // SullyOS Incremental summary update: append new entry snippet with length guard
        const sanitizedNewContent = sanitizeMemorySummary(entry.content);
        if (sanitizedNewContent) {
            const separator = activeBox.summary ? "\n" : "";
            const combined = `${activeBox.summary}${separator}· ${sanitizedNewContent}`.trim();
            // Guard against unbounded summary explosion before sealing
            activeBox.summary = capSummary(combined);
        }
    }

    let sealed = false;
    if (activeBox.eventCount >= maxEvents) {
        activeBox.status = "sealed";
        activeBox.sealedAt = now;
        sealed = true;
    }

    saveEventBoxes(characterId, boxes);
    return { box: activeBox, sealed };
}
