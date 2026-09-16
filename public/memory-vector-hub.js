// 记忆向量中枢 v12.3（优化版插件）
const SYS_TAG_NAME = "system_" + "instruction";
const RE_THINK_TAGS = [
  new RegExp("<think(?:ing)?>[\\s\\S]*?<\\/think(?:ing)?>", "gi"),
  new RegExp("<thought>[\\s\\S]*?<\\/thought>", "gi"),
  new RegExp("<reasoning>[\\s\\S]*?<\\/reasoning>", "gi"),
  new RegExp("<analysis>[\\s\\S]*?<\\/analysis>", "gi"),
  new RegExp("<" + SYS_TAG_NAME + ">[\\s\\S]*?<\\/" + SYS_TAG_NAME + ">", "gi"),
  new RegExp("\\[thinking\\][\\s\\S]*?\\[\\/thinking\\]", "gi"),
  new RegExp("\\[思考\\][\\s\\S]*?\\[\\/思考\\]", "g"),
  new RegExp("【思考】[\\s\\S]*?【\\/思考】", "g"),
  new RegExp("【思维链】[\\s\\S]*?【\\/思维链】", "g"),
  new RegExp("\\[内心\\][\\s\\S]*?\\[\\/内心\\]", "g"),
  /[（(]\s*(?:内心|思考|心声|独白)\s*[:：][^）)]*[）)]/g,
  /^\s*###[\s\S]*?<\/thinking>\s*/i,
  /^\s*#{2,}\s*Vol[\s\S]*?(?=\[引用:|\[表情包:|\S[\u4e00-\u9fa5])/i,
];

const RE_SANITIZE_PREFIX = /^\s*[-•]\s*/;
const RE_SANITIZE_QUOTE = /\[引用[:：][^\]]*\]/g;
const RE_SANITIZE_DATE = /[（(\[]\d{4}[-/.]\d{1,2}[-/.]\d{1,2}[^）)\]]*[）)\]]/g;
const RE_SANITIZE_SYS_BRACKET = /\[(微信聊天|朋友圈|动态|群聊|短信|系统|事件).*?\]/g;
const RE_SANITIZE_SPEAKER_GENERIC = /^(用户|角色|你|我|TA|对方|系统)\s*[:：]\s*/g;
const RE_SANITIZE_SPEAKER_NAME = /^[a-zA-Z0-9_\u4e00-\u9fa5]{1,12}\s*[:：]\s*/;
const RE_SPLIT_MAIN = /[。！？；!?;\n\s]+/;
const RE_SPLIT_SUB = /[，,、]+/;

export default {
  manifest: {
    id: "memory-vector-hub",
    name: "记忆向量与重排中枢",
    apiVersion: 1,
    version: "12.3.0",
    author: "小坊",
    description: "句子级检索 + 向量余弦相似度 + 关键词保送 + 性能与防爆优化。",
    permissions: ["chat.read", "ui", "storage", "network"],
    settings: [
      { key: "minSimilarity", label: "向量最低匹配门槛 (建议 0.25)", type: "number", default: 0.25 },
      { key: "rerankMinScore", label: "Rerank 最低有效分 (建议 0.50)", type: "number", default: 0.50 },
      { key: "longTermTopK", label: "长期记忆最多召回条数 (建议 3~4 条)", type: "number", default: 4 },
      { key: "shortTermMinTurns", label: "短期记忆保底轮数 (不足则往前补齐)", type: "number", default: 15 },
      { key: "keywordBoost", label: "关键词保送门槛 (建议 0.45)", type: "number", default: 0.45 },
      { key: "keywordGuaranteeMax", label: "关键词保送名额上限 (建议 1)", type: "number", default: 1 },
    ],
  },

  setup(ctx) {
    const MEM_DB = "ai_phone_memory_db_v1";
    const MEM_STORE = "memories";
    const KV_DB = "AiPhoneKvDB";
    const TAG_LONG = "memoryLongTerm";
    const TAG_SHORT_OPEN = "<shortTermMemory>";
    const TAG_SHORT_CLOSE = "</shortTermMemory>";
    const CACHE_KEY = "mvh_emb_cache_v12";

    const esc = (s) => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    const num = (key, dflt) => {
      const v = Number(ctx.system.settings.get(key));
      return Number.isFinite(v) && v > 0 ? v : dflt;
    };

    function withTimeout(promise, ms, label) {
      return Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error((label || "操作") + " 超时 " + ms + "ms")), ms)),
      ]);
    }

    function idbOpen(dbName) {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("打开数据库失败: " + dbName));
      });
    }

    async function loadSystemApiConfigs() {
      const db = await idbOpen(KV_DB);
      try {
        if (!db.objectStoreNames.contains("entries")) return [];
        return await new Promise((res) => {
          const tx = db.transaction("entries", "readonly");
          const req = tx.objectStore("entries").get("ai_phone_api_configs_v1");
          req.onsuccess = () => {
            try {
              const raw = req.result?.value;
              res(raw ? JSON.parse(raw) : []);
            } catch (e) { res([]); }
          };
          req.onerror = () => res([]);
        });
      } finally { db.close(); }
    }

    async function getLastSummaryTimestamp(charId) {
      if (!charId) return null;
      const db = await idbOpen(KV_DB);
      try {
        if (!db.objectStoreNames.contains("entries")) return null;
        return await new Promise((res) => {
          const tx = db.transaction("entries", "readonly");
          const req = tx.objectStore("entries").get("ai_phone_mem_last_sum_" + charId);
          req.onsuccess = () => res(req.result?.value || null);
          req.onerror = () => res(null);
        });
      } finally { db.close(); }
    }

    function resolveEmbedUrl(config) {
      if (config.baseUrl && config.baseUrl.trim()) {
        const b = config.baseUrl.trim().replace(/\/+$/, "");
        return b.endsWith("/embeddings") ? b : b + "/embeddings";
      }
      switch (config.provider) {
        case "SiliconFlow": return "https://api.siliconflow.cn/v1/embeddings";
        case "Zhipu":       return "https://open.bigmodel.cn/api/paas/v4/embeddings";
        default:            return "https://api.openai.com/v1/embeddings";
      }
    }
    function resolveEmbedModel(config) {
      return config.defaultModel?.trim() || "text-embedding-3-small";
    }
    function resolveRerankUrl(config) {
      if (config.baseUrl && config.baseUrl.trim()) {
        const b = config.baseUrl.trim().replace(/\/+$/, "");
        return b.endsWith("/rerank") ? b : b + "/rerank";
      }
      return "https://api.siliconflow.cn/v1/rerank";
    }
    function resolveRerankModel(config) {
      return config.defaultModel?.trim() || "BAAI/bge-reranker-v2-m3";
    }

    async function requestEmbedding(input, config) {
      if (!config || !config.apiKey) throw new Error("缺少 API Key");
      const isBatch = Array.isArray(input);
      if (isBatch && input.length === 0) return [];
      
      const url = resolveEmbedUrl(config);
      const model = resolveEmbedModel(config);
      const res = await ctx.system.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + config.apiKey },
        body: JSON.stringify({ model, input }),
      });
      const resText = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${resText.slice(0, 160)}`);
      let data;
      try { data = JSON.parse(resText); } catch (e) { throw new Error("非 JSON 返回"); }
      
      if (isBatch) {
        const list = data?.data;
        if (!Array.isArray(list)) throw new Error("批量接口未返回数组");
        return list.map((item) => item?.embedding).filter((vec) => Array.isArray(vec) && vec.length > 0);
      }
      const vec = data?.data?.[0]?.embedding;
      if (!Array.isArray(vec) || vec.length === 0) throw new Error("未返回 embedding 数组");
      return vec;
    }

    async function requestRerank(query, documents, config) {
      if (!config || !config.apiKey || documents.length === 0) return null;
      const url = resolveRerankUrl(config);
      const model = resolveRerankModel(config);
      try {
        const res = await ctx.system.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + config.apiKey },
          body: JSON.stringify({ model, query, documents, top_n: documents.length }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        const results = Array.isArray(data) ? data : (data?.results || data?.data || []);
        const scoreMap = new Map();
        results.forEach((item) => {
          const idx = Number(item.index ?? item.offset);
          const score = Number(item.relevance_score ?? item.score ?? 0);
          scoreMap.set(idx, score);
        });
        return scoreMap;
      } catch (e) { return null; }
    }

    function cosine(a, b) {
      if (!a || !b || a.length !== b.length) return 0;
      let dot = 0, ma = 0, mb = 0;
      for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i]; }
      const d = Math.sqrt(ma) * Math.sqrt(mb);
      return d === 0 ? 0 : dot / d;
    }

    function loadCache() {
      try { return JSON.parse(ctx.system.storage.get(CACHE_KEY) || "{}"); } catch (e) { return {}; }
    }
    function saveCache(cache) {
      try {
        const keys = Object.keys(cache);
        if (keys.length > 80) {
          const sub = {};
          keys.slice(keys.length - 50).forEach((k) => sub[k] = cache[k]);
          cache = sub;
        }
        ctx.system.storage.set(CACHE_KEY, JSON.stringify(cache));
      } catch (e) {}
    }

    async function readLongMemories(charId) {
      if (!charId) return [];
      const db = await idbOpen(MEM_DB);
      try {
        if (!db.objectStoreNames.contains(MEM_STORE)) return [];
        return await new Promise((res, rej) => {
          const tx = db.transaction(MEM_STORE, "readonly");
          const req = tx.objectStore(MEM_STORE).getAll();
          req.onsuccess = () => {
            const all = req.result || [];
            res(all.filter((r) => r?.type === "long_term" && r?.characterId === charId));
          };
          req.onerror = () => rej(req.error);
        });
      } finally { db.close(); }
    }

    async function batchWriteEmbeddings(updates) {
      if (updates.length === 0) return;
      const db = await idbOpen(MEM_DB);
      try {
        await new Promise((res, rej) => {
          const tx = db.transaction(MEM_STORE, "readwrite");
          const store = tx.objectStore(MEM_STORE);
          updates.forEach(({ id, embedding }) => {
            const getReq = store.get(id);
            getReq.onsuccess = () => {
              const item = getReq.result;
              if (item) {
                item.embedding = embedding;
                item.updatedAt = new Date().toISOString();
                store.put(item);
              }
            };
          });
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
        });
      } finally { db.close(); }
    }

    function stripThinking(text) {
      if (!text) return "";
      let s = String(text);
      for (const reg of RE_THINK_TAGS) {
        s = s.replace(reg, "");
      }
      return s.replace(/\n{3,}/g, "\n\n").trim();
    }

    function cleanDisplay(text) {
      if (!text) return "";
      let s = stripThinking(String(text));
      s = s.replace(/\s*\[object Object\]\s*/g, " ");
      s = s.replace(/\s+/g, " ").trim();
      return s;
    }

    function splitSentences(text) {
      if (!text) return [];
      const out = [];
      const mainParts = String(text).split(RE_SPLIT_MAIN);
      for (const p of mainParts) {
        const sub = p.split(RE_SPLIT_SUB);
        for (const s of sub) {
          const t = s.trim();
          if (t.length >= 3) out.push(t);
        }
      }
      if (out.length === 0) {
        const t = String(text).trim();
        if (t) out.push(t);
      }
      return out;
    }

    function isUsableMessage(msg) {
      if (!msg) return false;
      const role = msg.role;
      if (role !== "user" && role !== "assistant") return false;
      const cleaned = cleanDisplay(msg.content);
      if (cleaned.length < 1) return false;
      if (/^(\[object Object\][,，\s]*)+$/.test(cleaned)) return false;
      const sysPat = new RegExp('^["{]?' + SYS_TAG_NAME + '["\']?\\s*[:：]');
      if (sysPat.test(cleaned)) return false;
      return true;
    }

    function groupByRole(items) {
      const groups = [];
      let cur = null;
      for (const item of items) {
        const role = item.msg?.role || "unknown";
        if (!cur || cur.role !== role) {
          cur = { role, items: [item] };
          groups.push(cur);
        } else {
          cur.items.push(item);
        }
      }
      return groups;
    }

    function countTurns(groups) {
      return groups.filter((g) => g.role === "user").length
        + (groups.length > 0 && groups[groups.length - 1].role === "assistant" && !groups.some((g) => g.role === "user") ? 1 : 0);
    }

    function keepLastTurns(usableItems, maxTurns) {
      const groups = groupByRole(usableItems);
      const keep = new Set();
      if (groups.length === 0 || maxTurns <= 0) return { keep, groups: [] };
      const chosen = [];
      let userSeen = 0;
      for (let i = groups.length - 1; i >= 0; i--) {
        const g = groups[i];
        chosen.unshift(g);
        if (g.role === "user") {
          userSeen++;
          if (userSeen >= maxTurns) break;
        }
      }
      chosen.forEach((g) => g.items.forEach((it) => keep.add(it.msgIdx)));
      return { keep, groups: chosen };
    }

    function extractGrams(text) {
      const s = String(text || "");
      const gs = new Set();
      const cn = s.replace(/[^\u4e00-\u9fa5]/g, "");
      if (cn.length === 1) {
        gs.add(cn);
      } else {
        for (let i = 0; i + 1 < cn.length; i++) gs.add(cn.slice(i, i + 2));
      }
      const en = s.toLowerCase().match(/[a-zA-Z0-9]{2,}/g) || [];
      en.forEach((w) => gs.add(w));
      return gs;
    }

    function buildGramIndex(texts) {
      const docGrams = texts.map((t) => extractGrams(t));
      const df = new Map();
      for (const gs of docGrams) {
        for (const g of gs) df.set(g, (df.get(g) || 0) + 1);
      }
      return { docGrams, df, N: texts.length };
    }

    function sanitizeForEmbedding(rawText) {
      if (!rawText) return "";
      let clean = String(rawText)
        .replace(RE_SANITIZE_PREFIX, "")
        .replace(RE_SANITIZE_QUOTE, "")
        .replace(RE_SANITIZE_DATE, "")
        .replace(RE_SANITIZE_SYS_BRACKET, "")
        .replace(RE_SANITIZE_SPEAKER_GENERIC, "")
        .replace(RE_SANITIZE_SPEAKER_NAME, "")
        .trim();
      return clean.length >= 2 ? clean : String(rawText).trim();
    }

    async function retrieveLongMemories(charId, query, qVec, topK, minSim, kwBoost, rerankConfig, kwGuaranteeMax, rerankMinScore) {
      const dbRows = await readLongMemories(charId);
      const mems = dbRows
        .map((r) => {
          const disp = cleanDisplay(r.content || "");
          return {
            id: r.id,
            text: disp,
            pureText: sanitizeForEmbedding(disp),
            embedding: Array.isArray(r.embedding) && r.embedding.length > 0 ? r.embedding : null,
          };
        })
        .filter((c) => c.pureText.length >= 2);

      if (mems.length === 0) return { picked: [], usedRerank: false, diag: { reason: "库里没有长期记忆" } };

      const sents = [];
      for (const m of mems) {
        const ss = splitSentences(m.text);
        if (ss.length <= 1) {
          sents.push({ memId: m.id, sentText: m.text, pureText: m.pureText });
        } else {
          for (const s of ss) {
            const pt = sanitizeForEmbedding(s);
            if (pt.length >= 2) sents.push({ memId: m.id, sentText: s, pureText: pt });
          }
        }
      }
      if (sents.length === 0) return { picked: [], usedRerank: false, diag: { reason: "拆句后没候选" } };

      const { docGrams, df, N } = buildGramIndex(sents.map((s) => s.pureText));

      let qSentences = splitSentences(query);
      if (qSentences.length === 0) qSentences = [String(query).trim()];
      qSentences = qSentences.filter((s) => s.trim().length >= 3);
      if (qSentences.length === 0) qSentences = [String(query).trim()];
      const usedQSents = qSentences.slice(0, 15);

      const qSentWeights = usedQSents.map((qs) => {
        const grams = extractGrams(qs);
        const weights = [];
        let denom = 0;
        for (const g of grams) {
          const d = df.get(g) || 0;
          if (d === 0) continue;
          if (N >= 5 && d / N > 0.4) continue;
          const idf = Math.log(1 + N / d);
          weights.push({ g, idf });
          denom += idf;
        }
        return { text: qs, weights, denom };
      });

      const kwScoreOf = (idx) => {
        const dg = docGrams[idx];
        let maxScore = 0;
        let bestQ = "";
        let bestHitCount = 0;
        for (const { text, weights, denom } of qSentWeights) {
          if (denom === 0) continue;
          let sum = 0;
          let hitCount = 0;
          for (const { g, idf } of weights) {
            if (dg.has(g)) { sum += idf; hitCount++; }
          }
          const score = Math.min(1, sum / denom);
          if (score > maxScore) { maxScore = score; bestQ = text; bestHitCount = hitCount; }
        }
        return { score: maxScore, bestQ, hitCount: bestHitCount };
      };

      const memById = new Map(mems.map((m) => [m.id, m]));
      const scored = sents.map((s, i) => {
        const m = memById.get(s.memId);
        const vec = (m?.embedding && qVec && m.embedding.length === qVec.length)
          ? cosine(qVec, m.embedding) : 0;
        const kwRes = kwScoreOf(i);
        const kw = kwRes.score;
        const coarse = m?.embedding ? (0.5 * vec + 0.5 * kw) : (0.85 * kw);
        return {
          ...s,
          memText: m?.text || s.sentText,
          vec, kw,
          kwQuery: kwRes.bestQ,
          kwHitCount: kwRes.hitCount,
          coarse, rerank: null, final: coarse, source: "normal",
        };
      });

      const bestByMem = new Map();
      for (const s of scored) {
        const prev = bestByMem.get(s.memId);
        if (!prev || s.coarse > prev.coarse) bestByMem.set(s.memId, s);
      }
      let memBest = Array.from(bestByMem.values());
      memBest.sort((a, b) => b.coarse - a.coarse);

      let usedRerank = false;
      let pool = memBest.slice(0, Math.max(topK * 10, 30));
      if (rerankConfig && pool.length > 0) {
        const docs = pool.map((c) => c.pureText || c.sentText);
        const rerankMap = await requestRerank(query, docs, rerankConfig);
        if (rerankMap && rerankMap.size > 0) {
          usedRerank = true;
          pool = pool.map((c, idx) => {
            const rk = rerankMap.has(idx) ? rerankMap.get(idx) : null;
            return { ...c, rerank: rk, final: (rk != null ? rk : c.coarse) };
          });
          pool.sort((a, b) => b.final - a.final);
        }
      }

      const guaranteed = [];
      const sortedByKw = [...memBest].sort((a, b) => b.kw - a.kw);
      const gMax = Math.max(1, Math.floor(kwGuaranteeMax || 1));
      for (const c of sortedByKw) {
        if (guaranteed.length >= gMax) break;
        if (c.kw < kwBoost) continue;
        const qLen = (c.kwQuery || "").length;
        const isShortQuery = qLen <= 4;
        if (isShortQuery || c.kwHitCount >= 2) {
          guaranteed.push({ ...c, source: "keyword" });
        }
      }

      const VEC_SUPPORT = 0.15;
      const KW_SUPPORT = 0.50;
      const picked = [...guaranteed];
      const seen = new Set(guaranteed.map((g) => g.memId));

      for (const c of pool) {
        if (picked.length >= topK) break;
        if (seen.has(c.memId)) continue;

        if (usedRerank && c.rerank != null) {
          const rerankPass = c.rerank >= rerankMinScore;
          const supportPass = c.vec >= VEC_SUPPORT || c.kw >= KW_SUPPORT;
          if (!rerankPass || !supportPass) continue;
        } else {
          const noRerankPass = c.vec >= minSim || c.kw >= KW_SUPPORT;
          if (!noRerankPass) continue;
        }

        picked.push(c);
        seen.add(c.memId);
      }

      return {
        picked, usedRerank,
        diag: {
          sentCount: sents.length,
          qSentCount: usedQSents.length,
          topKw: sortedByKw[0]?.kw,
          topKwQuery: sortedByKw[0]?.kwQuery,
          topKwHitCount: sortedByKw[0]?.kwHitCount,
          topCoarse: memBest[0]?.coarse,
        },
      };
    }

    let lastSnapshots = null;

    // 关键修复：同时注册 prompt.system 和 llm.request，无论宿主触发哪个钩子都能 100% 捕获记忆注入
    async function processMemoryTransformation(payload) {
      try {
        let messages = payload.messages || [];
        if (!Array.isArray(messages) || messages.length === 0) return payload;

        // 无论何种 purpose，只要进到 LLM 请求就进行底稿解析与快照记录（仅过滤空请求）

        let currentPrompt = "";
        let prevAssistantPrompt = "";
        for (let i = messages.length - 1; i >= 0; i--) {
          if (!currentPrompt && messages[i]?.role === "user" && typeof messages[i].content === "string") {
            currentPrompt = messages[i].content.trim().slice(-150);
          } else if (currentPrompt && !prevAssistantPrompt && messages[i]?.role === "assistant" && typeof messages[i].content === "string") {
            prevAssistantPrompt = cleanDisplay(messages[i].content).slice(-100);
            break;
          }
        }

        const rawQuery = (prevAssistantPrompt ? (prevAssistantPrompt + " ") : "") + currentPrompt;
        const query = sanitizeForEmbedding(rawQuery) || currentPrompt || "聊天";

        const allConfigs = await loadSystemApiConfigs();
        const embedConfigId = ctx.system.storage.get("chosenEmbedConfigId");
        const rerankConfigId = ctx.system.storage.get("chosenRerankConfigId");
        const embedConfig = allConfigs.find((c) => c.id === embedConfigId) || allConfigs[0];
        const rerankConfig = allConfigs.find((c) => c.id === rerankConfigId) || null;

        const cache = loadCache();
        const hash = (s) => s.slice(0, 30) + "_" + s.length;

        let qVec = null;
        if (embedConfig && query) {
          const qKey = "q:" + hash(query);
          qVec = cache[qKey];
          if (!qVec) {
            try {
              qVec = await withTimeout(requestEmbedding(query, embedConfig), 4000, "实时向量计算");
              cache[qKey] = qVec;
              saveCache(cache);
            } catch (e) {
              ctx.system.log("[记忆中枢] Query 向量计算跳过（已自动降级）：", (e && e.message) || String(e));
            }
          }
        }

        let finalCoreList = [];
        let finalLongList = [];
        let finalShortList = [];
        let finalShortTurns = 0;
        let shortSupplemented = false;
        let watermarkTime = null;
        let longDiag = null;

        for (let i = 0; i < messages.length; i++) {
          if (typeof messages[i]?.content === "string") {
            const m = messages[i].content.match(/<memoryCore>([\s\S]*?)<\/memoryCore>/i);
            if (m) {
              finalCoreList = m[1].split("\n").filter((l) => l.trim().length > 0);
              break;
            }
          }
        }

        // 严格定位角色：必须来自真实的聊天会话（有 sessionId 且关联角色，或者明确指定了 characterId）
        let targetCharId = payload.characterId || "";
        if (!targetCharId && payload.sessionId) {
          const sess = ctx.data.sessions.get(payload.sessionId);
          targetCharId = sess?.contactId || (sess?.characterIds && sess.characterIds[0]) || "";
        }

        // 如果既没有会话也没有角色 ID（比如工坊自身对话、系统内置工具等非角色会话），绝对不触发记忆检索，原样放行！
        if (!targetCharId) {
          return payload;
        }

        {
          const topK = num("longTermTopK", 4);
          const minSim = Number(ctx.system.settings.get("minSimilarity") ?? 0.25);
          const kwBoost = Number(ctx.system.settings.get("keywordBoost") ?? 0.45);
          const kwGuaranteeMax = num("keywordGuaranteeMax", 1);
          const rerankMinScore = Number(ctx.system.settings.get("rerankMinScore") ?? 0.50);

          const { picked, diag } = await retrieveLongMemories(
            targetCharId, query, qVec, topK, minSim, kwBoost, rerankConfig, kwGuaranteeMax, rerankMinScore
          );
          longDiag = diag;
          finalLongList = picked.map((p) => ({
            text: p.memText, hitSentence: p.sentText, hitQuery: p.kwQuery,
            score: p.final, vec: p.vec, kw: p.kw, rerank: p.rerank,
            source: p.source, kwHitCount: p.kwHitCount,
          }));

          for (let i = 0; i < messages.length; i++) {
            if (typeof messages[i]?.content !== "string") continue;
            if (!messages[i].content.includes("<" + TAG_LONG + ">")) continue;
            const rawLong = messages[i].content;
            const reLong = new RegExp("<" + TAG_LONG + ">([\\s\\S]*?)<\\/" + TAG_LONG + ">", "i");
            const newBlock = picked.length > 0
              ? ("<" + TAG_LONG + ">\n" + picked.map((p) => p.memText).join("\n") + "\n</" + TAG_LONG + ">")
              : "";
            messages[i].content = rawLong.replace(reLong, () => newBlock);
            break;
          }
        }

        let shortStartIdx = -1;
        let shortEndIdx = -1;
        for (let i = 0; i < messages.length; i++) {
          const text = typeof messages[i]?.content === "string" ? messages[i].content : "";
          if (shortStartIdx < 0 && text.includes(TAG_SHORT_OPEN)) shortStartIdx = i;
          if (shortStartIdx >= 0 && text.includes(TAG_SHORT_CLOSE)) { shortEndIdx = i; break; }
        }

        if (shortStartIdx >= 0 && shortEndIdx >= shortStartIdx) {
          watermarkTime = await getLastSummaryTimestamp(targetCharId);
          const allInner = [];
          for (let i = shortStartIdx + 1; i < shortEndIdx; i++) {
            allInner.push({ msgIdx: i, msg: messages[i] });
          }
          const allUsable = allInner.filter((it) => isUsableMessage(it.msg));

          let incremental = allInner;
          if (watermarkTime) {
            incremental = allInner.filter((item) => {
              const ts = item.msg?.createdAt || item.msg?.timestamp;
              return !ts || ts > watermarkTime;
            });
          }
          const incUsable = incremental.filter((it) => isUsableMessage(it.msg));
          const incTurns = countTurns(groupByRole(incUsable));

          const minTurns = num("shortTermMinTurns", 15);
          const targetTurns = Math.max(incTurns, minTurns);
          if (incTurns < minTurns) shortSupplemented = true;

          const { keep, groups } = keepLastTurns(allUsable, targetTurns);

          payload.messages = messages.filter((msg, idx) => {
            if (idx > shortStartIdx && idx < shortEndIdx) {
              if (!keep.has(idx)) return false;
              if (msg.role === "assistant" && typeof msg.content === "string") {
                msg.content = stripThinking(msg.content);
              }
              return Boolean(msg.content && msg.content.trim().length > 0);
            }
            return true;
          });

          finalShortTurns = groups.filter((g) => g.role === "user").length;
          finalShortList = groups.map((g) => {
            const roleName = g.role === "assistant" ? "角色" : "你";
            const merged = g.items
              .map((it) => cleanDisplay(String(it.msg?.content || "")))
              .filter((t) => t.length > 0)
              .join(" / ");
            if (!merged) return null;
            return `[${roleName}] ${merged.slice(0, 400)}`;
          }).filter(Boolean);
        }

        lastSnapshots = {
          query, core: finalCoreList, long: finalLongList, short: finalShortList,
          shortTurns: finalShortTurns, shortSupplemented, watermark: watermarkTime,
          longDiag, at: new Date().toLocaleTimeString(),
        };
        ctx.system.storage.set("last_mvh_snapshot", JSON.stringify(lastSnapshots));

        return payload;
      } catch (err) {
        ctx.system.log("[记忆中枢] 运行异常：", err);
        return payload;
      }
    }

    ctx.hooks.transform("llm.request", processMemoryTransformation, { priority: 50, timeoutMs: 35000 });

    async function openCenterModal(sessionId) {
      const chars = ctx.data.characters.list() || [];
      const session = sessionId ? ctx.data.sessions.get(sessionId) : null;
      let currentCharId = session?.contactId || chars[0]?.id;

      const systemConfigs = await loadSystemApiConfigs();
      let chosenEmbedConfigId = ctx.system.storage.get("chosenEmbedConfigId") || systemConfigs[0]?.id;
      let chosenRerankConfigId = ctx.system.storage.get("chosenRerankConfigId") || "";

      ctx.ui.openModal((el, api) => {
        el.style.width = "94vw";
        el.style.maxWidth = "540px";
        el.style.maxHeight = "88vh";
        el.style.overflowY = "auto";
        el.style.fontSize = "13px";
        el.style.lineHeight = "1.6";
        el.style.background = "#f8fafc";
        el.style.color = "#0f172a";
        el.style.padding = "16px";
        el.style.borderRadius = "14px";
        el.style.boxShadow = "0 20px 25px -5px rgba(0,0,0,0.2)";

        el.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;border-bottom:1px solid #e2e8f0;padding-bottom:8px;">
            <b style="font-size:17px;color:#1e293b;">🧠 记忆向量与重排中枢</b>
            <button id="mvhClose" style="background:#e2e8f0;border:none;width:28px;height:28px;border-radius:50%;font-size:14px;cursor:pointer;color:#475569;display:flex;align-items:center;justify-content:center;">✕</button>
          </div>
          <div style="margin-bottom:12px;">
            <label style="font-size:12px;font-weight:600;color:#64748b;">当前检测角色：</label>
            <select id="mvhCharSelect" style="width:100%;padding:6px 10px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;margin-top:3px;font-size:13px;color:#0f172a;"></select>
          </div>
          <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:8px 10px;margin-bottom:12px;font-size:11px;color:#1e40af;line-height:1.5;">
            💡 <b>核心记忆</b>每次必注入；<b>长期记忆</b>按需检索。<br>
            🚀 关键词保送（kw ≥ 保送门槛 且命中≥2词）· 🎯 向量或 Rerank 命中
          </div>
          <div id="mvhBody">读取中...</div>
        `;

        el.querySelector("#mvhClose").onclick = api.close;
        const charSelect = el.querySelector("#mvhCharSelect");
        charSelect.innerHTML = chars.map((c) => `<option value="${esc(c.id)}">${esc(c.name || c.id)}</option>`).join("");
        charSelect.value = currentCharId;
        const body = el.querySelector("#mvhBody");

        async function refresh() {
          body.innerHTML = '<div style="color:#64748b;padding:16px 0;text-align:center;">正在读取本地记忆状态...</div>';
          try {
            if (!lastSnapshots) {
              try {
                const storedSnap = ctx.system.storage.get("last_mvh_snapshot");
                if (storedSnap) lastSnapshots = JSON.parse(storedSnap);
              } catch (e) {}
            }
            const longMemories = await readLongMemories(currentCharId);
            const withVec = longMemories.filter((r) => Array.isArray(r.embedding) && r.embedding.length > 0);
            const missing = longMemories.filter((r) => !Array.isArray(r.embedding) || r.embedding.length === 0);

            body.innerHTML = `
              <div style="background:#fff;border:1px solid #cbd5e1;border-radius:12px;padding:14px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;border-bottom:1px dashed #e2e8f0;padding-bottom:6px;">
                  <span style="font-weight:700;font-size:14px;color:#334155;">📋 AI 实际接收到的记忆底稿</span>
                  <span style="font-size:11px;background:#f1f5f9;color:#64748b;padding:2px 8px;border-radius:99px;">${lastSnapshots ? lastSnapshots.at : '未触发'}</span>
                </div>
                ${lastSnapshots ? `
                  <div style="font-size:11px;background:#f8fafc;padding:6px 8px;border-radius:6px;margin-bottom:10px;color:#475569;border-left:3px solid #6366f1;">
                    <strong>纯语义 Query：</strong>${esc(lastSnapshots.query)}
                  </div>
                  <div style="margin-bottom:12px;">
                    <div style="font-size:12px;font-weight:700;color:#047857;margin-bottom:6px;">
                      <span>✦ 长期记忆 (句子级检索命中 ${lastSnapshots.long.length} 条)</span>
                    </div>
                    ${lastSnapshots.long.length > 0 ? `
                      <div style="display:flex;flex-direction:column;gap:6px;">
                        ${lastSnapshots.long.map(item => `
                          <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:8px 10px;font-size:12px;color:#064e3b;line-height:1.5;">
                            <div style="font-size:10px;font-weight:700;color:#059669;margin-bottom:2px;">
                              ${item.source === 'keyword' ? '🚀 关键词保送' : '🎯 向量/Rerank'} · 总分 ${(item.score).toFixed(3)} · 向量 ${(item.vec||0).toFixed(3)} · 关键词 ${(item.kw||0).toFixed(3)}${item.rerank!=null?` · Rerank ${item.rerank.toFixed(3)}`:''}
                            </div>
                            <div style="font-size:10px;color:#0d9488;background:#f0fdfa;padding:3px 6px;border-radius:4px;margin-bottom:4px;">
                              🎯 命中句：${esc(item.hitSentence || '')}<br>
                              🔍 匹配的 query 片段：${esc(item.hitQuery || '')}${item.kwHitCount!=null?` （命中 ${item.kwHitCount} 词）`:''}
                            </div>
                            ${esc(item.text)}
                          </div>
                        `).join('')}
                      </div>
                    ` : `<div style="font-size:12px;color:#94a3b8;background:#f8fafc;padding:8px;border-radius:6px;border:1px dashed #e2e8f0;">
                      未命中。诊断：候选句 ${lastSnapshots.longDiag?.sentCount||0} · query拆句 ${lastSnapshots.longDiag?.qSentCount||0} · 最高关键词分 ${(lastSnapshots.longDiag?.topKw||0).toFixed(3)}（命中 ${lastSnapshots.longDiag?.topKwHitCount||0} 词）· 最高粗排 ${(lastSnapshots.longDiag?.topCoarse||0).toFixed(3)}
                    </div>`}
                  </div>
                  <div style="margin-bottom:12px;">
                    <div style="font-size:12px;font-weight:700;color:#0369a1;margin-bottom:6px;">
                      <span>✦ 短期记忆 (${lastSnapshots.shortTurns||0} 轮 / ${lastSnapshots.short.length} 组${lastSnapshots.shortSupplemented?'，已从水位线之前补齐':''})</span>
                    </div>
                    ${lastSnapshots.short.length > 0 ? `
                      <div style="display:flex;flex-direction:column;gap:5px;max-height:220px;overflow-y:auto;padding-right:4px;">
                        ${lastSnapshots.short.map(s => `
                          <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;padding:6px 8px;font-size:12px;color:#0c4a6e;line-height:1.4;">${esc(s)}</div>
                        `).join('')}
                      </div>
                    ` : '<div style="font-size:12px;color:#94a3b8;padding:4px 0;">当前暂无未总结增量</div>'}
                  </div>
                  <div>
                    <div style="font-size:12px;font-weight:700;color:#b45309;margin-bottom:6px;">
                      <span>✦ 核心记忆 (灵魂底色，100%原生保底共 ${lastSnapshots.core.length} 条)</span>
                    </div>
                    <div style="display:flex;flex-direction:column;gap:5px;max-height:260px;overflow-y:auto;">
                      ${lastSnapshots.core.map(c => `
                        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:6px 8px;font-size:12px;color:#78350f;">${esc(c)}</div>
                      `).join('')}
                    </div>
                  </div>
                ` : `
                  <div style="color:#64748b;font-size:12px;padding:12px;text-align:center;background:#f8fafc;border-radius:8px;">
                    请在聊天框随意发一句话，插件会真实拦截并在此呈现发给 AI 的底稿状态！
                  </div>
                `}
              </div>

              <div style="background:#fff;border:1px solid #cbd5e1;border-radius:12px;padding:14px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
                <div style="font-weight:700;font-size:14px;color:#334155;margin-bottom:8px;">🔎 关键词搜索测试（长期记忆库）</div>
                <div style="font-size:11px;color:#64748b;margin-bottom:6px;">只搜长期记忆库。核心记忆不在这里。</div>
                <div style="display:flex;gap:8px;">
                  <input id="mvhSearchInput" placeholder="输入关键词，如：物理" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid #cbd5e1;background:#fff;font-size:12px;color:#0f172a;" />
                  <button id="mvhSearchBtn" style="padding:6px 12px;border-radius:6px;border:none;background:#0f172a;color:#fff;font-size:12px;font-weight:600;cursor:pointer;">搜索</button>
                </div>
                <div id="mvhSearchLog" style="font-size:11px;margin-top:8px;color:#334155;white-space:pre-wrap;max-height:260px;overflow-y:auto;"></div>
              </div>

              <div style="background:#fff;border:1px solid #cbd5e1;border-radius:12px;padding:14px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
                <div style="font-weight:700;font-size:14px;color:#334155;margin-bottom:8px;">🔌 模型配置与向量补齐</div>
                <div style="margin-bottom:10px;">
                  <div style="font-size:12px;color:#64748b;margin-bottom:3px;">向量 Embedding 配置：</div>
                  <div style="display:flex;gap:8px;">
                    <select id="mvhEmbedSelect" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid #cbd5e1;background:#fff;font-size:12px;color:#0f172a;">
                      ${systemConfigs.map((c) => `<option value="${esc(c.id)}" ${c.id === chosenEmbedConfigId ? 'selected' : ''}>${esc(c.name || c.provider)} (${esc(c.defaultModel || '默认')})</option>`).join("")}
                    </select>
                    <button id="mvhTestEmbedBtn" style="padding:6px 12px;border-radius:6px;border:none;background:#4f46e5;color:#fff;font-size:12px;font-weight:600;cursor:pointer;">测试向量</button>
                  </div>
                </div>
                <div style="margin-bottom:10px;">
                  <div style="font-size:12px;color:#64748b;margin-bottom:3px;">重排 Rerank 配置：</div>
                  <div style="display:flex;gap:8px;">
                    <select id="mvhRerankSelect" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid #cbd5e1;background:#fff;font-size:12px;color:#0f172a;">
                      <option value="">不使用 Rerank (纯语义向量)</option>
                      ${systemConfigs.map((c) => `<option value="${esc(c.id)}" ${c.id === chosenRerankConfigId ? 'selected' : ''}>${esc(c.name || c.provider)} (${esc(c.defaultModel || '默认')})</option>`).join("")}
                    </select>
                    <button id="mvhTestRerankBtn" style="padding:6px 12px;border-radius:6px;border:none;background:#059669;color:#fff;font-size:12px;font-weight:600;cursor:pointer;">测试重排</button>
                  </div>
                </div>
                <div id="mvhTestLog" style="font-size:11px;padding:8px;border-radius:6px;background:#f1f5f9;display:none;white-space:pre-wrap;margin-bottom:10px;"></div>
                <div style="display:flex;justify-content:space-between;font-size:12px;color:#475569;margin-bottom:6px;">
                  <span>长期记忆总数：${longMemories.length} 条</span>
                  <span>已具备纯净向量：${withVec.length} 条</span>
                </div>
                ${missing.length > 0 ? `
                  <button id="mvhFillBtn" style="width:100%;padding:8px;border-radius:8px;border:none;background:#6366f1;color:#fff;font-weight:700;cursor:pointer;margin-top:4px;">
                    ⚡ 快速批量补算向量 (${missing.length} 条)
                  </button>
                  <div id="mvhFillLog" style="font-size:11px;margin-top:6px;color:#d97706;white-space:pre-wrap;"></div>
                ` : `
                  <div style="padding:6px;background:#ecfdf5;color:#059669;border-radius:6px;font-size:12px;text-align:center;border:1px solid #a7f3d0;">
                    ✓ 长期记忆已 100% 具备纯净语义向量。
                  </div>
                `}
              </div>
            `;

            const searchInput = el.querySelector("#mvhSearchInput");
            const searchBtn = el.querySelector("#mvhSearchBtn");
            const searchLog = el.querySelector("#mvhSearchLog");
            const doSearch = async () => {
              const kw = (searchInput.value || "").trim();
              if (!kw) { searchLog.textContent = "请输入关键词"; return; }
              searchBtn.disabled = true;
              searchLog.innerHTML = '<span style="color:#2563eb;">⏳ [1/3] 检查核心记忆...</span>';

              try {
                const coreText = (lastSnapshots?.core || []).join("\n");
                const coreHas = coreText.includes(kw);
                const containing = longMemories.filter((r) => String(r.content || "").includes(kw));

                if (containing.length === 0 && !coreHas) {
                  searchLog.innerHTML = `<span style="color:#dc2626;">✗ 核心记忆和长期记忆库都不含"${esc(kw)}"。</span>`;
                  searchBtn.disabled = false;
                  return;
                }

                if (containing.length === 0 && coreHas) {
                  searchLog.innerHTML = `<div style="color:#0369a1;background:#eff6ff;padding:8px;border-radius:6px;border-left:3px solid #3b82f6;">
                    ✓ <b>核心记忆里命中"${esc(kw)}"</b> —— 每次请求都会注入，不需要检索。
                  </div>`;
                  searchBtn.disabled = false;
                  return;
                }

                searchLog.innerHTML = `<span style="color:#2563eb;">⏳ [2/3] 计算 query 向量（最长 10 秒）...</span>`;
                const cfg = systemConfigs.find((c) => c.id === chosenEmbedConfigId) || systemConfigs[0];
                let qVecTest = null;
                let vecErr = null;
                if (cfg) {
                  try {
                    qVecTest = await withTimeout(requestEmbedding(kw, cfg), 10000, "向量");
                  } catch (e) { vecErr = e.message; }
                }

                searchLog.innerHTML = `<span style="color:#2563eb;">⏳ [3/3] 检索打分中${vecErr ? '（向量失败，退回纯关键词）' : ''}...</span>`;
                const rkCfg = systemConfigs.find((c) => c.id === chosenRerankConfigId) || null;
                const { picked } = await retrieveLongMemories(
                  currentCharId, kw, qVecTest, 5,
                  Number(ctx.system.settings.get("minSimilarity") ?? 0.25),
                  Number(ctx.system.settings.get("keywordBoost") ?? 0.45),
                  rkCfg,
                  Number(ctx.system.settings.get("keywordGuaranteeMax") ?? 1),
                  Number(ctx.system.settings.get("rerankMinScore") ?? 0.50)
                );

                let html = "";
                if (coreHas) {
                  html += `<div style="color:#0369a1;background:#eff6ff;padding:6px 8px;border-radius:6px;border-left:3px solid #3b82f6;margin-bottom:8px;">
                    ✓ 核心记忆里也命中"${esc(kw)}"（已全量注入）
                  </div>`;
                }
                if (vecErr) {
                  html += `<div style="color:#d97706;background:#fffbeb;padding:6px 8px;border-radius:6px;border-left:3px solid #f59e0b;margin-bottom:8px;">
                    ⚠ 向量计算失败：${esc(vecErr)}
                  </div>`;
                }

                if (picked.length === 0) {
                  html += `<div style="color:#d97706;">长期记忆库含"${esc(kw)}"共 ${containing.length} 条，但检索没命中。</div>`;
                } else {
                  html += picked.map((p, idx) => `
                    <div style="padding:6px;border-left:3px solid ${p.source === 'keyword' ? '#f59e0b' : '#059669'};background:${p.source === 'keyword' ? '#fffbeb' : '#f0fdfa'};margin-bottom:6px;border-radius:4px;">
                      <div style="font-size:10px;color:#059669;font-weight:700;margin-bottom:2px;">
                        ${p.source === 'keyword' ? '🚀 保送' : '🎯 命中'} #${idx + 1} 总分 ${p.final.toFixed(3)} · 向量 ${p.vec.toFixed(3)} · 关键词 ${p.kw.toFixed(3)}${p.rerank != null ? ` · Rerank ${p.rerank.toFixed(3)}` : ''}
                      </div>
                      <div style="font-size:10px;color:#0d9488;background:#ecfeff;padding:2px 5px;border-radius:3px;margin-bottom:3px;">🎯 ${esc(p.sentText)}</div>
                      <div style="font-size:11px;color:#334155;">${esc(p.memText.slice(0, 150))}...</div>
                    </div>
                  `).join('');
                }
                searchLog.innerHTML = html;
              } catch (err) {
                searchLog.innerHTML = `<span style="color:#dc2626;">搜索出错: ${esc(err.message || String(err))}</span>`;
              } finally {
                searchBtn.disabled = false;
              }
            };
            if (searchBtn) searchBtn.onclick = doSearch;
            if (searchInput) searchInput.onkeydown = (e) => { if (e.key === "Enter") doSearch(); };

            const embedSelect = el.querySelector("#mvhEmbedSelect");
            if (embedSelect) embedSelect.onchange = (e) => {
              chosenEmbedConfigId = e.target.value;
              ctx.system.storage.set("chosenEmbedConfigId", chosenEmbedConfigId);
            };
            const rerankSelect = el.querySelector("#mvhRerankSelect");
            if (rerankSelect) rerankSelect.onchange = (e) => {
              chosenRerankConfigId = e.target.value;
              ctx.system.storage.set("chosenRerankConfigId", chosenRerankConfigId);
            };

            const testLog = el.querySelector("#mvhTestLog");
            const testEmbedBtn = el.querySelector("#mvhTestEmbedBtn");
            if (testEmbedBtn) testEmbedBtn.onclick = async () => {
              testEmbedBtn.disabled = true;
              testLog.style.display = "block";
              testLog.style.color = "#2563eb";
              testLog.textContent = "正在调用选中的 Embedding 配置进行测试（最长 10 秒）...";
              try {
                const cfg = systemConfigs.find((c) => c.id === chosenEmbedConfigId) || systemConfigs[0];
                const start = Date.now();
                const vec = await withTimeout(requestEmbedding("测试纯净语义向量", cfg), 10000, "向量");
                const cost = Date.now() - start;
                testLog.style.color = "#059669";
                testLog.textContent = `✓ 向量测试成功！维度: ${vec.length} 维 (${cost}ms)`;
              } catch (err) {
                testLog.style.color = "#dc2626";
                testLog.textContent = `✗ 向量测试失败: ${err.message}`;
              } finally { testEmbedBtn.disabled = false; }
            };

            const testRerankBtn = el.querySelector("#mvhTestRerankBtn");
            if (testRerankBtn) testRerankBtn.onclick = async () => {
              const cfg = systemConfigs.find((c) => c.id === chosenRerankConfigId);
              if (!cfg) {
                testLog.style.display = "block";
                testLog.style.color = "#d97706";
                testLog.textContent = "请先在下拉菜单中选中一个 Rerank 配置。";
                return;
              }
              testRerankBtn.disabled = true;
              testLog.style.display = "block";
              testLog.style.color = "#2563eb";
              testLog.textContent = "正在调用选中的 Rerank 配置打分...";
              try {
                const map = await requestRerank("测试", ["相关语句A", "完全不相干的话B"], cfg);
                if (map && map.size > 0) {
                  testLog.style.color = "#059669";
                  testLog.textContent = `✓ Rerank 测试成功！模型: ${resolveRerankModel(cfg)}`;
                } else throw new Error("接口未返回预期打分结果");
              } catch (err) {
                testLog.style.color = "#dc2626";
                testLog.textContent = `✗ Rerank 测试失败: ${err.message}`;
              } finally { testRerankBtn.disabled = false; }
            };

            const fillBtn = el.querySelector("#mvhFillBtn");
            const fillLog = el.querySelector("#mvhFillLog");
            if (fillBtn) fillBtn.onclick = async () => {
              const cfg = systemConfigs.find((c) => c.id === chosenEmbedConfigId) || systemConfigs[0];
              fillBtn.disabled = true;
              fillBtn.textContent = "正在分批计算入库...";
              fillLog.style.color = "#d97706";
              fillLog.textContent = "开始分批计算纯净语义向量，请勿离开窗口...";
              
              try {
                const BATCH_SIZE = 10;
                let doneCount = 0;

                for (let i = 0; i < missing.length; i += BATCH_SIZE) {
                  const chunk = missing.slice(i, i + BATCH_SIZE);
                  const texts = chunk.map((item) => sanitizeForEmbedding(cleanDisplay(item.content)));
                  fillLog.textContent = `计算进度: ${doneCount}/${missing.length}...`;

                  let vectors = null;
                  try {
                    vectors = await withTimeout(requestEmbedding(texts, cfg), 20000, "批量向量计算");
                  } catch (e) {
                    vectors = await Promise.all(
                      texts.map((t) => withTimeout(requestEmbedding(t, cfg), 10000, "向量"))
                    );
                  }

                  const updates = chunk.map((item, idx) => ({
                    id: item.id,
                    embedding: vectors[idx],
                  })).filter((u) => Array.isArray(u.embedding) && u.embedding.length > 0);

                  if (updates.length > 0) {
                    await batchWriteEmbeddings(updates);
                  }
                  doneCount += chunk.length;
                }

                fillLog.style.color = "#059669";
                fillLog.textContent = "✓ 长期记忆已全部完成纯净语义向量计算并入库！";
                ctx.ui.toast("向量补全成功！");
                setTimeout(refresh, 1200);
              } catch (err) {
                fillLog.style.color = "#dc2626";
                fillLog.textContent = "计算失败: " + err.message;
                fillBtn.disabled = false;
                fillBtn.textContent = "重试";
              }
            };
          } catch (e) {
            body.innerHTML = '<div style="color:#dc2626;">读取失败: ' + esc(e.message) + '</div>';
          }
        }

        charSelect.onchange = () => { currentCharId = charSelect.value; refresh(); };
        refresh();
      });
    }

    // 聊天窗口内悬浮可拖拽、自动贴边精致小圆球
    ctx.ui.slot("chat.header", (el, props) => {
      // 避免重复挂载
      const existing = document.getElementById("mvh-floating-ball");
      if (existing) existing.remove();

      const ball = document.createElement("div");
      ball.id = "mvh-floating-ball";
      ball.title = "点击查看记忆底稿（可拖拽贴边）";
      ball.style.cssText = `
        position: fixed !important;
        right: 12px !important;
        bottom: 120px !important;
        width: 42px !important;
        height: 42px !important;
        border-radius: 50% !important;
        background: linear-gradient(135deg, #6366f1, #8b5cf6) !important;
        color: #fff !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        font-size: 20px !important;
        box-shadow: 0 6px 16px rgba(99,102,241,0.45) !important;
        cursor: grab !important;
        user-select: none !important;
        touch-action: none !important;
        z-index: 99999 !important;
        pointer-events: auto !important;
        transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.2s, opacity 0.25s;
      `;
      ball.innerHTML = "🧠";
      document.body.appendChild(ball);

      let isDragging = false;
      let startX = 0, startY = 0;
      let initX = 0, initY = 0;
      let hasMoved = false;

      const onPointerDown = (e) => {
        isDragging = true;
        hasMoved = false;
        ball.style.cursor = "grabbing";
        ball.style.transition = "none";
        ball.style.transform = "scale(1.12)";
        startX = e.clientX || (e.touches && e.touches[0].clientX);
        startY = e.clientY || (e.touches && e.touches[0].clientY);
        const rect = ball.getBoundingClientRect();
        initX = rect.left;
        initY = rect.top;
        e.stopPropagation();
      };

      const onPointerMove = (e) => {
        if (!isDragging) return;
        const curX = e.clientX || (e.touches && e.touches[0].clientX);
        const curY = e.clientY || (e.touches && e.touches[0].clientY);
        const dx = curX - startX;
        const dy = curY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
        ball.style.left = `${Math.max(8, Math.min(window.innerWidth - 46, initX + dx))}px`;
        ball.style.top = `${Math.max(60, Math.min(window.innerHeight - 80, initY + dy))}px`;
        ball.style.right = "auto";
        ball.style.bottom = "auto";
      };

      const onPointerUp = () => {
        if (!isDragging) return;
        isDragging = false;
        ball.style.cursor = "grab";
        ball.style.transform = "scale(1)";
        ball.style.transition = "left 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), transform 0.2s";
        
        const rect = ball.getBoundingClientRect();
        const midX = window.innerWidth / 2;
        if (rect.left + rect.width / 2 < midX) {
          ball.style.left = "10px"; // 自动贴左边
        } else {
          ball.style.left = `${window.innerWidth - 48}px`; // 自动贴右边
        }
      };

      ball.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);

      ball.onclick = (e) => {
        if (!hasMoved) {
          openCenterModal(props?.sessionId);
        }
      };

      return () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        ball.remove();
      };
    });

    ctx.ui.slot("chat.inputToolbar", (el, props) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "🧠 记忆中枢";
      btn.style.cssText = "padding:4px 10px;border-radius:12px;font-size:11px;cursor:pointer;margin:4px 6px 0 0;"
        + "border:1px solid rgba(99,102,241,.4);background:rgba(99,102,241,.15);color:#818cf8;font-weight:600;";
      btn.onclick = () => openCenterModal(props?.sessionId);
      el.appendChild(btn);
      return () => btn.remove();
    });

    ctx.ui.messageAction({
      id: "mvh-open",
      label: "🧠 记忆中枢",
      onSelect: (msg) => openCenterModal(msg?.sessionId),
    });
  },
};
