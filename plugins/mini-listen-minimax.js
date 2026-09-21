const DEFAULT_ENDPOINT = "https://api.minimax.chat/v1/t2a_v2";
const TAG = "mini-listen-minimax";

function esc(value) {
  return String(value ?? "").replace(/[&<>\"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function splitText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split(/\n+|(?<=[。！？!?；;])\s*/u)
    .map(s => s.trim())
    .filter(Boolean);
}

function hexToDataUrl(hex, mime = "audio/mp3") {
  const clean = String(hex || "").replace(/\s/g, "");
  const bytes = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return `data:${mime};base64,${btoa(binary)}`;
}

function audioFromResponse(json) {
  const audio = json?.data?.audio || json?.audio;
  if (audio) return /^[0-9a-f]+$/i.test(audio) ? hexToDataUrl(audio) : `data:audio/mp3;base64,${audio}`;
  if (json?.base64_audio) return `data:audio/mp3;base64,${json.base64_audio}`;
  throw new Error(json?.base_resp?.status_msg || "Minimax 未返回音频");
}

export default {
  manifest: {
    id: TAG,
    name: "声阅 Mini · 边聊边听",
    apiVersion: 1,
    version: "1.0.0",
    author: "qi431931-design",
    description: "在聊天界面打开迷你听书窗，导入 TXT 或粘贴文本，使用 Minimax 逐段朗读。",
    permissions: ["chat.read", "ui", "network", "storage"],
    settings: [
      { key: "apiKey", label: "Minimax API Key", type: "text", default: "", description: "仅保存在本机插件设置中。" },
      { key: "groupId", label: "Minimax Group ID", type: "text", default: "" },
      { key: "endpoint", label: "TTS 接口地址", type: "text", default: DEFAULT_ENDPOINT },
      { key: "model", label: "朗读模型", type: "select", default: "speech-2.8-turbo", options: [
        { value: "speech-2.8-turbo", label: "speech-2.8-turbo" },
        { value: "speech-2.8-hd", label: "speech-2.8-hd" },
        { value: "speech-01-turbo", label: "speech-01-turbo" },
        { value: "speech-01-hd", label: "speech-01-hd" },
      ] },
      { key: "voiceId", label: "Voice ID", type: "text", default: "male-qn-qingse" },
      { key: "speed", label: "语速", type: "number", default: 1 },
      { key: "volume", label: "音量", type: "number", default: 1 },
    ],
  },

  setup(ctx) {
    const state = {
      title: ctx.system.storage.get("title") || "未命名听书",
      paragraphs: ctx.system.storage.get("paragraphs") || [],
      index: Number(ctx.system.storage.get("index") || 0),
      playing: false,
      loading: false,
      audio: null,
      modal: null,
      bar: null,
    };

    const setting = key => ctx.system.settings.get(key);
    const saveBook = () => {
      ctx.system.storage.set("title", state.title);
      ctx.system.storage.set("paragraphs", state.paragraphs);
      ctx.system.storage.set("index", state.index);
    };
    const toast = text => ctx.ui.toast(text);

    function stopAudio() {
      if (state.audio) {
        state.audio.pause();
        state.audio.src = "";
        state.audio = null;
      }
      state.playing = false;
    }

    function refresh() {
      const title = `${state.title} · ${state.paragraphs.length ? `${state.index + 1}/${state.paragraphs.length}` : "未导入"}`;
      if (state.bar) {
        state.bar.querySelector("[data-title]").textContent = title;
        state.bar.querySelector("[data-status]").textContent = state.loading ? "生成中…" : state.playing ? "朗读中" : "已暂停";
        state.bar.querySelector("[data-play]").textContent = state.playing ? "暂停" : "播放";
      }
      if (state.modal) {
        state.modal.querySelector("[data-modal-title]").textContent = title;
        state.modal.querySelector("[data-modal-status]").textContent = state.loading ? "正在请求 Minimax…" : state.playing ? "朗读中" : "已暂停";
        state.modal.querySelector("[data-modal-play]").textContent = state.playing ? "暂停" : "播放";
        state.modal.querySelector("[data-current]").textContent = state.paragraphs[state.index] || "请先导入 TXT 或粘贴文本";
      }
    }

    async function synthesize(text) {
      const apiKey = String(setting("apiKey") || "").trim();
      const groupId = String(setting("groupId") || "").trim();
      if (!apiKey || !groupId) throw new Error("请先在插件设置中填写 Minimax API Key 和 Group ID");
      const endpoint = String(setting("endpoint") || DEFAULT_ENDPOINT).trim();
      const speed = Math.min(2, Math.max(0.5, Number(setting("speed")) || 1));
      const volume = Math.min(2, Math.max(0, Number(setting("volume")) || 1));
      const response = await ctx.system.fetch(`${endpoint}${endpoint.includes("?") ? "&" : "?"}GroupId=${encodeURIComponent(groupId)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: setting("model") || "speech-2.8-turbo",
          text,
          stream: false,
          voice_setting: { voice_id: setting("voiceId") || "male-qn-qingse", speed, vol: volume, pitch: 0 },
          audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
        }),
      });
      if (!response.ok) throw new Error(`Minimax 请求失败（HTTP ${response.status}）`);
      return audioFromResponse(await response.json());
    }

    async function playCurrent() {
      if (!state.paragraphs.length) return toast("请先导入或粘贴听书文本");
      if (state.index >= state.paragraphs.length) state.index = 0;
      if (state.playing) {
        state.audio?.pause();
        state.playing = false;
        refresh();
        return;
      }
      state.loading = true;
      refresh();
      try {
        const dataUrl = await synthesize(state.paragraphs[state.index]);
        if (state.audio) state.audio.pause();
        const audio = new Audio(dataUrl);
        state.audio = audio;
        audio.onended = () => {
          if (!state.playing) return;
          state.index += 1;
          if (state.index >= state.paragraphs.length) {
            state.index = state.paragraphs.length - 1;
            state.playing = false;
            toast("听书完成");
          }
          saveBook();
          refresh();
          if (state.playing) void playCurrent();
        };
        audio.onerror = () => { state.playing = false; toast("音频播放失败"); refresh(); };
        await audio.play();
        state.playing = true;
      } catch (error) {
        state.playing = false;
        toast(error instanceof Error ? error.message : String(error));
      } finally {
        state.loading = false;
        refresh();
      }
    }

    function openPlayer() {
      if (state.modal) return;
      state.modal = ctx.ui.openModal((el, api) => {
        el.style.cssText = "padding:16px;max-width:520px;width:100%;background:var(--c-card-bg,#fff);color:var(--c-text,#111);border-radius:18px;";
        el.innerHTML = `
          <div class="${TAG}-head"><strong data-modal-title></strong><button data-close>×</button></div>
          <div class="${TAG}-current" data-current></div>
          <div class="${TAG}-status" data-modal-status></div>
          <div class="${TAG}-controls"><button data-prev>上一段</button><button data-modal-play>播放</button><button data-next>下一段</button></div>
          <label class="${TAG}-import">导入 TXT <input data-file type="file" accept=".txt,text/plain" hidden /></label>
          <textarea data-text placeholder="也可以直接粘贴文本，再点击导入文本"></textarea>
          <div class="${TAG}-row"><input data-title-input placeholder="书名" /><button data-save>导入文本</button></div>
        `;
        el.querySelector("[data-close]").onclick = api.close;
        el.querySelector("[data-modal-play]").onclick = () => void playCurrent();
        el.querySelector("[data-prev]").onclick = () => { state.index = Math.max(0, state.index - 1); saveBook(); refresh(); };
        el.querySelector("[data-next]").onclick = () => { state.index = Math.min(Math.max(0, state.paragraphs.length - 1), state.index + 1); saveBook(); refresh(); };
        el.querySelector("[data-save]").onclick = () => {
          const text = el.querySelector("[data-text]").value;
          const parts = splitText(text);
          if (!parts.length) return toast("请粘贴听书文本");
          stopAudio(); state.paragraphs = parts; state.index = 0;
          state.title = el.querySelector("[data-title-input]").value.trim() || "未命名听书";
          saveBook(); refresh(); toast(`已导入 ${parts.length} 段`);
        };
        el.querySelector("[data-file]").onchange = async event => {
          const file = event.target.files?.[0];
          if (!file) return;
          const text = await file.text();
          el.querySelector("[data-text]").value = text;
          el.querySelector("[data-title-input]").value = file.name.replace(/\.[^.]+$/, "");
        };
        refresh();
        return () => { state.modal = null; };
      });
    }

    ctx.ui.injectCSS(`
      .${TAG}-bar{display:flex;align-items:center;gap:8px;padding:7px 10px;margin:6px 0;border-radius:12px;background:color-mix(in srgb,var(--c-card-bg,#fff) 88%,#7657d9);border:1px solid color-mix(in srgb,var(--c-card-border,#ddd) 70%,#7657d9);font-size:12px}
      .${TAG}-bar [data-title]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.${TAG}-bar button,.${TAG}-controls button,.${TAG}-row button{border:0;border-radius:9px;padding:8px 11px;background:#7657d9;color:#fff}.${TAG}-bar [data-status]{opacity:.65}.${TAG}-head,.${TAG}-row,.${TAG}-controls{display:flex;align-items:center;gap:8px}.${TAG}-head{justify-content:space-between;margin-bottom:12px}.${TAG}-head button{border:0;background:none;font-size:22px}.${TAG}-current{min-height:90px;padding:12px;border-radius:12px;background:color-mix(in srgb,var(--c-card-bg,#fff) 88%,#7657d9);line-height:1.7}.${TAG}-status{font-size:12px;opacity:.65;margin:9px 0}.${TAG}-controls{justify-content:center}.${TAG}-import{display:block;margin-top:16px;padding:10px;border:1px dashed #aaa;border-radius:10px;text-align:center}.${TAG}-row{margin-top:10px}.${TAG}-row input,.${TAG}-modal textarea, .${TAG}-row input{min-width:0;flex:1}.${TAG}-bar button{padding:6px 9px}.${TAG}-bar [data-open]{background:transparent;color:inherit;border:1px solid currentColor}
      [data-chat-plugin="${TAG}"] textarea{width:100%;min-height:110px;margin-top:10px;padding:10px;border:1px solid #aaa;border-radius:10px;resize:vertical;background:transparent;color:inherit}
    `);

    ctx.ui.slot("chat.header", (el) => {
      state.bar = el;
      el.innerHTML = `<div class="${TAG}-bar"><span data-title></span><span data-status></span><button data-play>播放</button><button data-open>听书</button></div>`;
      el.querySelector("[data-play]").onclick = () => void playCurrent();
      el.querySelector("[data-open]").onclick = openPlayer;
      refresh();
      return () => { state.bar = null; stopAudio(); };
    });

    ctx.ui.slot("chat.inputToolbar", (el) => {
      const button = document.createElement("button");
      button.textContent = "声阅 Mini";
      button.style.cssText = "border:0;border-radius:9px;padding:7px 10px;background:#7657d9;color:#fff;";
      button.onclick = openPlayer;
      el.appendChild(button);
      return () => button.remove();
    });

    ctx.system.log("声阅 Mini v1.0.0 已启动");
    return () => stopAudio();
  },
};
