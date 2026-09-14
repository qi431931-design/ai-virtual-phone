// lib/memory-rerank.ts
// Optional cross-encoder rerank pass for memory retrieval.
// Any failure (未绑定 / 模型不匹配 / 接口报错) returns null and the caller keeps
// its original order — rerank never blocks or breaks a reply.

import type { ApiConfig } from "./settings-types";
import type { MemoryEntry } from "./memory-types";
import { determineBaseUrl, buildRequestHeaders } from "./api-helpers";
import { resolveAuxiliaryApiConfig } from "./settings-storage";

/** 送进重排候选池的条数上限（池外条目按原顺序垫底，不会被丢弃） */
export const DEFAULT_RERANK_CANDIDATES = 24;

/** provider → 内置重排模型映射（未列出的服务商按「模型名含 rerank」判定） */
export function getRerankModelForProvider(provider: string): string | null {
    switch (provider) {
        case "SiliconFlow": return "BAAI/bge-reranker-v2-m3";
        default: return null;
    }
}

const RERANK_MODEL_NAME_RE = /rerank/i;

export function isRerankModelName(model: string | undefined): boolean {
    return Boolean(model && RERANK_MODEL_NAME_RE.test(model));
}

/**
 * 解析该配置应使用的重排模型：
 * 默认模型名里带 rerank（jina-reranker / rerank-v3.5 / gte-rerank-v2 等）就直接用，
 * 否则回退按服务商的内置映射；两者都没有则返回 null（= 不做重排）。
 */
export function resolveRerankModel(apiConfig: Pick<ApiConfig, "provider" | "defaultModel">): string | null {
    const model = apiConfig.defaultModel?.trim();
    if (model && isRerankModelName(model)) return model;
    return getRerankModelForProvider(apiConfig.provider);
}

/**
 * 调用重排接口，返回按相关度降序的 {index, score}（index 对应 documents 下标）。
 * 兼容 results / output.results / data 三种常见返回结构；失败返回 null。
 * Base URL 直接以 /rerank 结尾时按原样使用（适配路径不同的服务商）。
 */
export async function rerankDocuments(
    query: string,
    documents: string[],
    apiConfig: ApiConfig,
    options: { topN?: number } = {}
): Promise<{ index: number; score: number }[] | null> {
    const model = resolveRerankModel(apiConfig);
    if (!model || documents.length < 2 || !query.trim()) return null;
    if (!apiConfig.apiKey) return null;

    const baseUrl = determineBaseUrl(apiConfig);
    if (!baseUrl) return null;
    const url = baseUrl.endsWith("/rerank")
        ? baseUrl
        : `${baseUrl.replace(/\/$/, "")}/rerank`;

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: buildRequestHeaders(apiConfig, baseUrl),
            body: JSON.stringify({
                model,
                query,
                documents,
                top_n: options.topN ?? documents.length,
            }),
        });
        if (!res.ok) {
            console.warn(`[MemoryRerank] API 错误 ${res.status}: ${await res.text()}`);
            return null;
        }
        const data = await res.json();
        const raw = Array.isArray(data)
            ? data
            : (data?.results ?? data?.output?.results ?? data?.data ?? null);
        if (!Array.isArray(raw)) {
            console.warn("[MemoryRerank] 接口未返回可识别的重排结果");
            return null;
        }

        const parsed = raw.map(item => {
            const index = Number(item?.index ?? item?.offset);
            const score = Number(
                item?.relevance_score ?? item?.score ?? item?.similarity ?? item?.relevance ?? 0
            );
            return { index, score };
        }).filter(r =>
            Number.isInteger(r.index)
            && r.index >= 0
            && r.index < documents.length
            && Number.isFinite(r.score)
        );

        if (parsed.length === 0) return null;
        parsed.sort((a, b) => b.score - a.score);
        return parsed;
    } catch (err) {
        console.warn("[MemoryRerank] fetch error:", err);
        return null;
    }
}

/**
 * 用重排模型给一批记忆重排一次。
 * - 未绑定重排 API / 模型名不像重排模型 → null（调用方保持原顺序，不额外消耗）
 * - 只把前 candidates 条送进候选池；池外条目按原顺序接在后面
 */
export async function rerankMemories(
    query: string,
    entries: MemoryEntry[],
    options: { candidates?: number } = {}
): Promise<MemoryEntry[] | null> {
    if (entries.length < 2 || !query.trim()) return null;

    const apiConfig = resolveAuxiliaryApiConfig("rerankApiConfigId");
    if (!apiConfig || !resolveRerankModel(apiConfig)) return null;

    const candidateCount = Math.min(
        Math.max(options.candidates ?? DEFAULT_RERANK_CANDIDATES, 2),
        entries.length
    );
    const candidates = entries.slice(0, candidateCount);
    const results = await rerankDocuments(
        query,
        candidates.map(e => e.content),
        apiConfig,
        { topN: candidateCount }
    );
    if (!results) return null;

    const ranked: MemoryEntry[] = [];
    const usedIndexes = new Set<number>();
    for (const r of results) {
        if (usedIndexes.has(r.index)) continue;
        usedIndexes.add(r.index);
        ranked.push(candidates[r.index]);
    }
    if (ranked.length === 0) return null;

    // 未被重排模型返回的条目保持原顺序垫底，避免静默丢弃
    const rankedIds = new Set(ranked.map(e => e.id));
    return [...ranked, ...entries.filter(e => !rankedIds.has(e.id))];
}
