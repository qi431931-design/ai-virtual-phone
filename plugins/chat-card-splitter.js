export default {
  manifest: {
    id: "chat-card-splitter",
    name: "字卡切分",
    apiVersion: 1,
    version: "1.0.0",
    author: "小坊",
    description: "提取当前聊天记录并切分为字卡，支持过滤常见思维链和导出",
    permissions: ["chat.read", "ui"],
    settings: [
      { key: "minLength", label: "字卡最短长度", type: "number", default: 1 },
      { key: "maxLength", label: "字卡最长长度", type: "number", default: 80 }
    ]
  },

  setup(ctx) {
    let sessionId = null;
    let modal = null;

    const toast = (text) => ctx.ui.toast(text);
    const settingNumber = (key, fallback) => {
      const n = Number(ctx.system.settings.get(key));
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };

    ctx.hooks.on("session.opened", (p) => {
      if (p?.sessionId) sessionId = p.sessionId;
    });

    function textOf(content) {
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content.map((x) => {
          if (typeof x === "string") return x;
          if (x && typeof x === "object") return x.text || x.content || "";
          return "";
        }).filter(Boolean).join("\n");
      }
      if (content && typeof content === "object") {
        return content.text || content.content || "";
      }
      return "";
    }

    function removeThoughts(input) {
      let text = String(input || "");
      const tags = [
        "think", "thinking", "thought", "analysis", "reasoning",
        "思维链", "思考", "推理", "分析过程", "推理过程"
      ];
      for (const tag of tags) {
        const t = tag.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
        text = text.replace(new RegExp(`<${t}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${t}\\s*>`, "gi"), "");
        text = text.replace(new RegExp(`\\[${t}\\][\\s\\S]*?\\[\\/${t}\\]`, "gi"), "");
        text = text.replace(new RegExp(`【${t}】[\\s\\S]*?【\\/${t}】`, "gi"), "");
      }
      text = text.split(/\r?\n/).filter((line) => {
        return !/^(思维链|思考过程|推理过程|分析过程|内部推理|analysis|reasoning)\s*[:：]/i.test(line.trim());
      }).join("\n");
      return text.replace(/<!--[\\s\\S]*?-->/g, "");
    }

    function splitText(input) {
      const min = settingNumber("minLength", 1);
      const max = Math.max(min, settingNumber("maxLength", 80));
      const text = removeThoughts(input)
        .replace(/\r/g, "")
        .replace(/[ \t]+/g, " ")
        .trim();
      const pieces = text.split(/[\n。！？!?；;，,、]+/).map((x) => x.trim()).filter(Boolean);
      const result = [];
      for (const piece of pieces) {
        if (piece.length < min) continue;
        for (let i = 0; i < piece.length; i += max) {
          const part = piece.slice(i, i + max).trim();
          if (part.length >= min) result.push(part);
        }
      }
      return [...new Set(result)];
    }

    function collect(mode) {
      if (!sessionId) return { cards: [], error: "请先进入一个聊天会话。" };
      const messages = ctx.data.messages.list(sessionId) || [];
      const cards = [];
      for (const message of messages) {
        if (!message) continue;
        if (mode === "character" && message.role !== "assistant") continue;
        if (mode === "both" && !["assistant", "user"].includes(message.role)) continue;
        cards.push(...splitText(textOf(message.content)));
      }
      return { cards: [...new Set(cards)], error: "" };
    }

    function download(name, content, type) {
      const url = URL.createObjectURL(new Blob([content], { type }));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function jsonData(cards) {
      return {
        text: [["聊天提取", cards]],
        kaomoji: [], emoji: [], sticker: [], image: [], poke: [], voice: [],
        fish: [], eat: [], period: [], water: [], garden: [], sync: [], reach: [],
        cjian: [], room: [], piggy: [], drift: [], interact: [], music: [], mjplus: []
      };
    }

    function openModal() {
      if (modal) return;
      modal = ctx.ui.openModal((el, api) => {
        el.style.cssText = "width:min(92vw,560px);max-height:86vh;overflow:auto;padding:18px;border-radius:16px;background:var(--c-card-bg,#fff);color:var(--c-text,#111);box-sizing:border-box";
        const title = document.createElement("h2");
        title.textContent = "字卡切分";
        title.style.margin = "0 0 8px";
        const tip = document.createElement("p");
        tip.textContent = "只读取当前聊天记录，不调用 AI，不修改聊天。带标签的思维链会被过滤。";
        tip.style.cssText = "font-size:13px;opacity:.7;line-height:1.5";
        const mode = document.createElement("select");
        mode.style.cssText = "width:100%;padding:9px;margin:8px 0";
        mode.innerHTML = "<option value=character>只切分角色字卡</option><option value=both>角色和用户一起切分</option>";
        const preview = document.createElement("pre");
        preview.style.cssText = "white-space:pre-wrap;word-break:break-word;min-height:110px;max-height:280px;overflow:auto;padding:12px;border-radius:8px;background:#8882;font-size:13px;line-height:1.55";
        const count = document.createElement("div");
        count.style.cssText = "font-size:12px;opacity:.65;margin:8px 0";
        const row = document.createElement("div");
        row.style.cssText = "display:flex;flex-wrap:wrap;gap:8px";
        const button = (label) => { const b = document.createElement("button"); b.textContent = label; b.type = "button"; b.style.cssText = "border:0;border-radius:8px;padding:9px 11px;cursor:pointer"; return b; };
        const split = button("开始切分");
        const txt = button("导出 TXT");
        const json = button("导出 JSON");
        const copy = button("复制纯文本");
        const close = button("关闭");
        let cards = [];
        const refresh = () => {
          const result = collect(mode.value);
          cards = result.cards;
          count.textContent = result.error || `共切分出 ${cards.length} 条字卡`;
          preview.textContent = result.error || (cards.length ? cards.map((x, i) => `${i + 1}. ${x}`).join("\n") : "没有提取到字卡。");
        };
        const ensure = () => { if (!cards.length) refresh(); if (!cards.length) { toast("当前没有可以导出的字卡。"); return false; } return true; };
        split.onclick = refresh;
        txt.onclick = () => { if (!ensure()) return; download("chat-cards.txt", cards.join("\n"), "text/plain;charset=utf-8"); toast("TXT 已导出。"); };
        json.onclick = () => { if (!ensure()) return; download("chat-cards.json", JSON.stringify(jsonData(cards), null, 2), "application/json;charset=utf-8"); toast("JSON 已导出。"); };
        copy.onclick = async () => { if (!ensure()) return; try { await navigator.clipboard.writeText(cards.join("\n")); toast("字卡已复制。"); } catch { toast("复制失败，请检查浏览器剪贴板权限。"); } };
        close.onclick = api.close;
        row.append(split, txt, json, copy, close);
        el.append(title, tip, mode, preview, count, row);
        refresh();
        return () => { modal = null; };
      });
    }

    ctx.ui.slot("chat.header", (el, props) => {
      if (props?.sessionId) sessionId = props.sessionId;
      const b = document.createElement("button");
      b.textContent = "字卡切分";
      b.type = "button";
      b.style.cssText = "border:0;border-radius:8px;padding:6px 10px;margin:5px;cursor:pointer";
      b.onclick = openModal;
      el.appendChild(b);
      return () => b.remove();
    });

    ctx.ui.slot("chat.inputToolbar", (el) => {
      const b = document.createElement("button");
      b.textContent = "字卡切分";
      b.type = "button";
      b.style.cssText = "border:0;border-radius:8px;padding:7px 10px;margin:4px;cursor:pointer";
      b.onclick = openModal;
      el.appendChild(b);
      return () => b.remove();
    });
  }
};
