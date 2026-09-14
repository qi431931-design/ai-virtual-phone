// lib/event-box-service.ts
// SullyOS-inspired EventBox management and aggregation service.

import type { EventBox, MemoryEntry } from "./memory-types";
import { sanitizeMemorySummary } from "./memory-guard";

const EVENT_BOX_KEY_PREFIX = "aivp_event_boxes_";

export function loadEventBoxes(characterId: string): EventBox[] {
    if (typeof localStorage === "undefined") return [];
    try {
        const raw = localStorage.getItem(`${EVENT_BOX_KEY_PREFIX}${characterId}`);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

export function saveEventBoxes(characterId: string, boxes: EventBox[]): void {
    if (typeof localStorage === "undefined") return;
    try {
        localStorage.setItem(`${EVENT_BOX_KEY_PREFIX}${characterId}`, JSON.stringify(boxes));
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
            summary: sanitizeMemorySummary(entry.content),
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
