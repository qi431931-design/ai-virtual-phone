const ENDPOINT = "https://api.minimax.chat/v1/t2a_v2";
const ID = "mini-listen-minimax";

function parts(text) {
  return String(text || "").replace(/\r/g, "").split(/\n+|(?<=[。！？!?；;])\s*/u).map(s => s.trim()).filter(Boolean);
}
function hexAudio(hex) {
  const b = new Uint8Array((hex.length / 2) | 0);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  let s = "";
  for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768));
  return `data:audio/mp3;base64,${btoa(s)}`;
}
function scopeCss(css) {
  return String(css || "").replace(/(^|})\s*([^@}{][^{}]*)\{/g, (all, prefix, selectors) => {
    const scoped = selectors.split(",").map(s => {
      const value = s.trim();
      return value ? `.sy-mini-wrap ${value}` : value;
    }).join(", ");
    return `${prefix}\n${scoped} {`;
  });
}
const SUPPORTED_SPEECH_TAGS = ["(laughs)", "(chuckle)", "(coughs)", "(clear-throat)", "(groans)", "(breath)", "(pant)", "(inhale)", "(exhale)", "(gasps)", "(sniffs)", "(sighs)", "(snorts)", "(burps)", "(lip-smacking)", "(humming)", "(hissing)", "(emm)", "(sneezes)"];
const SUPPORTED_TAG_RE = /\((laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\)/g;

function cleanSpeechTags(text) {
  return String(text || "").replace(SUPPORTED_TAG_RE, (_, tag) => `(${tag})`).replace(/\((?!laughs\)|chuckle\)|coughs\)|clear-throat\)|groans\)|breath\)|pant\)|inhale\)|exhale\)|gasps\)|sniffs\)|sighs\)|snorts\)|burps\)|lip-smacking\)|humming\)|hissing\)|emm\)|sneezes\))[^)]*\)/g, "").replace(/[<>「」『』【】[\]{}（）]/g, " ").replace(/\s{2,}/g, " ").trim();
}

function audioData(json) {
  const a = json?.data?.audio || json?.audio;
  if (a) return /^[0-9a-f]+$/i.test(a) ? hexAudio(a) : `data:audio/mp3;base64,${a}`;
  if (json?.base64_audio) return `data:audio/mp3;base64,${json.base64_audio}`;
  throw new Error(json?.base_resp?.status_msg || "Minimax 未返回音频");
}

export default {
  manifest: {
    id: ID,
    name: "声阅 Mini · 边聊边听",
    apiVersion: 1,
    version: "1.3.0",
    author: "qi431931-design",
    description: "聊天界面迷你听书：导入 TXT 或粘贴文本，Minimax 逐段朗读；每段结束自动暂停。",
    permissions: ["chat.read", "ui", "network", "storage"],
    settings: [
      { key: "apiKey", label: "Minimax API Key", type: "text", default: "", description: "仅保存在本机插件设置中。" },
      { key: "groupId", label: "Minimax Group ID", type: "text", default: "" },
      { key: "endpoint", label: "TTS 接口地址", type: "text", default: ENDPOINT },
      { key: "model", label: "朗读模型", type: "select", default: "speech-2.8-turbo", options: [{ value: "speech-2.8-turbo", label: "speech-2.8-turbo" }, { value: "speech-2.8-hd", label: "speech-2.8-hd" }, { value: "speech-01-turbo", label: "speech-01-turbo" }, { value: "speech-01-hd", label: "speech-01-hd" }] },
      { key: "voiceId", label: "Voice ID", type: "text", default: "male-qn-qingse" },
      { key: "speed", label: "语速", type: "number", default: 1 },
      { key: "volume", label: "音量", type: "number", default: 1 },
      { key: "continuous", label: "自动连续播放", type: "boolean", default: false, description: "关闭时每段结束自动暂停；开启后自动播放下一段。" },
      { key: "preprocess", label: "AI 文本预处理", type: "boolean", default: false, description: "朗读前优化停顿和语气；只允许内置的 19 种 Minimax 语气词。" },
      { key: "preloadCount", label: "预生成接下来几段", type: "number", default: 5, description: "点击预生成后，提前请求并缓存音频。" },
      { key: "customCss", label: "自定义 CSS", type: "text", default: "", description: "只作用于声阅 Mini；建议使用 .sy-mini-bar、.sy-modal 等声阅 Mini 类名。" },
    ],
  },
  setup(ctx) {
    const get = key => ctx.system.settings.get(key);
    const state = {
      title: ctx.system.storage.get("title") || "未命名听书",
      list: ctx.system.storage.get("paragraphs") || [],
      index: Number(ctx.system.storage.get("index") || 0),
      playing: false, loading: false, audio: null, bar: null, modal: null, hidden: false,
      audioCache: new Map(), generationToken: 0,
    };
    const save = () => { ctx.system.storage.set("title", state.title); ctx.system.storage.set("paragraphs", state.list); ctx.system.storage.set("index", state.index); };
    const toast = text => ctx.ui.toast(text);
    const stop = () => { state.generationToken += 1; if (state.audio) { state.audio.pause(); state.audio.src = ""; state.audio = null; } state.playing = false; refresh(); };
    const css = ctx.ui.injectCSS(`
      .sy-mini-wrap{position:fixed;right:8px;top:42%;z-index:9999;transition:transform .2s ease}.sy-mini-wrap.sy-hidden{transform:translateX(calc(100% - 25px))}.sy-mini-bar{display:flex;align-items:center;gap:7px;max-width:360px;padding:8px 10px;border:1px solid color-mix(in srgb,var(--c-card-border,#ddd) 70%,#7657d9);border-radius:14px;background:color-mix(in srgb,var(--c-card-bg,#fff) 92%,#7657d9);box-shadow:0 8px 24px #0002;font-size:12px}.sy-mini-title{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sy-mini-status{opacity:.65}.sy-mini-bar button,.sy-controls button,.sy-row button{border:0;border-radius:9px;padding:7px 10px;background:#7657d9;color:#fff}.sy-mini-bar [data-edge]{background:transparent;color:inherit;border:0;font-size:16px;padding:2px}.sy-head,.sy-controls,.sy-row{display:flex;align-items:center;gap:8px}.sy-head{justify-content:space-between;margin-bottom:12px}.sy-current{min-height:90px;padding:12px;border-radius:12px;background:color-mix(in srgb,var(--c-card-bg,#fff) 88%,#7657d9);line-height:1.7}.sy-status{font-size:12px;opacity:.65;margin:9px 0}.sy-import{display:block;margin-top:16px;padding:10px;border:1px dashed #999;border-radius:10px;text-align:center}.sy-row{margin-top:10px}.sy-row input,.sy-text{min-width:0;flex:1}.sy-text{width:100%;min-height:110px;margin-top:10px;padding:10px;border:1px solid #aaa;border-radius:10px;resize:vertical;background:transparent;color:inherit}.sy-controls{justify-content:center}
      ${scopeCss(get("customCss"))}
    `);
    const refresh = () => {
      const title = `${state.title} · ${state.list.length ? `${state.index + 1}/${state.list.length}` : "未导入"}`;
      if (state.bar) { state.bar.querySelector("[data-title]").textContent = title; state.bar.querySelector("[data-status]").textContent = state.loading ? "生成中…" : state.playing ? "朗读中" : "已暂停"; state.bar.querySelector("[data-play]").textContent = state.playing ? "暂停" : "播放"; }
      if (state.modal) { state.modal.querySelector("[data-title-modal]").textContent = title; state.modal.querySelector("[data-status-modal]").textContent = state.loading ? "正在请求 Minimax…" : state.playing ? "朗读中" : "已暂停"; state.modal.querySelector("[data-play-modal]").textContent = state.playing ? "暂停" : "播放"; state.modal.querySelector("[data-current]").textContent = state.list[state.index] || "请先导入 TXT 或粘贴文本"; }
    };
    async function tts(text) {
      const key = String(get("apiKey") || "").trim(), group = String(get("groupId") || "").trim();
      if (!key || !group) throw new Error("请先在插件设置中填写 Minimax API Key 和 Group ID");
      const endpoint = String(get("endpoint") || ENDPOINT);
      let speechText = cleanSpeechTags(text);
      if (get("preprocess") === true && ctx.ai?.chat) {
        const processed = await ctx.ai.chat({ system: `你是有声书 TTS 文本预处理器。保持事实、人物、顺序和原意，不要解释。只可使用这些语气词：${SUPPORTED_SPEECH_TAGS.join(" ")}。不要创造任何其他括号标签；不需要语气词就不要添加。只输出处理后的朗读文本。`, prompt: speechText, temperature: 0.2, maxTokens: Math.max(256, speechText.length * 2) });
        speechText = cleanSpeechTags(processed || speechText);
      }
      const response = await ctx.system.fetch(`${endpoint}${endpoint.includes("?") ? "&" : "?"}GroupId=${encodeURIComponent(group)}`,  { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: get("model") || "speech-2.8-turbo", text: speechText, stream: false, voice_setting: { voice_id: get("voiceId") || "male-qn-qingse", speed: Number(get("speed")) || 1, vol: Number(get("volume")) || 1, pitch: 0 }, audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 } }) });
      if (!response.ok) throw new Error(`Minimax 请求失败（HTTP ${response.status}）`);
      return audioData(await response.json());
    }
    async function getAudio(index) {
      if (state.audioCache.has(index)) return state.audioCache.get(index);
      const data = await tts(state.list[index]);
      state.audioCache.set(index, data);
      return data;
    }
    async function preGenerate() {
      if (!state.list.length) return toast("请先导入或粘贴听书文本");
      const count = Math.max(1, Math.min(50, Number(get("preloadCount")) || 5));
      const end = Math.min(state.list.length, state.index + count);
      const tip = toast(`正在生成接下来 ${end - state.index} 段…`, { durationMs: 0 });
      try {
        for (let i = state.index; i < end; i += 1) {
          await getAudio(i);
          refresh();
        }
        toast(`已生成 ${end - state.index} 段音频`);
      } catch (e) { toast(e instanceof Error ? e.message : String(e)); }
      finally { tip.close(); }
    }
    async function play() {
      if (!state.list.length) return toast("请先导入或粘贴听书文本");
      if (state.playing) { state.audio?.pause(); state.playing = false; refresh(); return; }
      state.loading = true; refresh();
      const token = ++state.generationToken;
      try {
        const audio = new Audio(await getAudio(state.index));
        if (token !== state.generationToken) return;
        state.audio = audio;
        audio.onended = () => {
          state.playing = false;
          save();
          refresh();
          if (get("continuous") === true && state.index < state.list.length - 1) {
            state.index += 1;
            save();
            void play();
          } else if (state.index >= state.list.length - 1) {
            toast("听书完成");
          } else {
            toast("本段已结束，点击播放继续");
          }
        };
        audio.onerror = () => { state.playing = false; refresh(); toast("音频播放失败"); };
        await audio.play(); state.playing = true;
      } catch (e) { state.playing = false; toast(e instanceof Error ? e.message : String(e)); }
      finally { state.loading = false; refresh(); }
    }
    function open() {
      if (state.modal) return;
      state.modal = ctx.ui.openModal((el, api) => {
        el.style.cssText = "padding:16px;max-width:520px;width:100%;background:var(--c-card-bg,#fff);color:var(--c-text,#111);border-radius:18px;";
        el.innerHTML = `<div class="sy-head"><strong data-title-modal></strong><button data-close>×</button></div><div class="sy-current" data-current></div><div class="sy-status" data-status-modal></div><div class="sy-controls"><button data-prev>上一段</button><button data-play-modal>播放</button><button data-next>下一段</button><button data-preload>预生成</button></div><label class="sy-import">选择 TXT <input data-file type="file" accept=".txt,text/plain" hidden></label><textarea class="sy-text" data-text placeholder="也可以粘贴文本"></textarea><div class="sy-row"><input data-book-title placeholder="书名"><button data-save>导入文本</button></div>`;
        el.querySelector("[data-close]").onclick = api.close;
        el.querySelector("[data-play-modal]").onclick = () => void play();
        el.querySelector("[data-preload]").onclick = () => void preGenerate();
        el.querySelector("[data-prev]").onclick = () => { state.index = Math.max(0, state.index - 1); save(); refresh(); };
        el.querySelector("[data-next]").onclick = () => { state.index = Math.min(Math.max(0, state.list.length - 1), state.index + 1); save(); refresh(); };
        el.querySelector("[data-save]").onclick = () => { const p = parts(el.querySelector("[data-text]").value); if (!p.length) return toast("请粘贴听书文本"); stop(); state.list = p; state.index = 0; state.title = el.querySelector("[data-book-title]").value.trim() || "未命名听书"; save(); refresh(); toast(`已导入 ${p.length} 段`); };
        el.querySelector("[data-file]").onchange = async e => { const f = e.target.files?.[0]; if (!f) return; el.querySelector("[data-text]").value = await f.text(); el.querySelector("[data-book-title]").value = f.name.replace(/\.[^.]+$/, ""); };
        refresh(); return () => { state.modal = null; };
      });
    }
    ctx.ui.slot("chat.header", el => {
      state.bar = el; el.className += " sy-mini-wrap"; el.innerHTML = `<div class="sy-mini-bar"><button data-edge title="贴边隐藏">‹</button><span class="sy-mini-title" data-title></span><span class="sy-mini-status" data-status></span><button data-play>播放</button><button data-open>听书</button></div>`;
      el.querySelector("[data-play]").onclick = () => void play(); el.querySelector("[data-open]").onclick = open;
      el.querySelector("[data-edge]").onclick = () => { state.hidden = !state.hidden; el.classList.toggle("sy-hidden", state.hidden); el.querySelector("[data-edge]").textContent = state.hidden ? "›" : "‹"; };
      refresh(); return () => { state.bar = null; stop(); };
    });
    ctx.ui.slot("chat.inputToolbar", el => {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;";
      const openButton = document.createElement("button");
      openButton.textContent = "声阅 Mini";
      const toggleButton = document.createElement("button");
      const buttonCss = "border:0;border-radius:9px;padding:7px 10px;background:#7657d9;color:#fff";
      openButton.style.cssText = buttonCss;
      toggleButton.style.cssText = buttonCss + ";background:transparent;color:inherit;border:1px solid currentColor";
      const syncToggle = () => {
        toggleButton.textContent = state.hidden ? "显示听书窗" : "隐藏听书窗";
        if (state.bar) state.bar.classList.toggle("sy-hidden", state.hidden);
      };
      openButton.onclick = open;
      toggleButton.onclick = () => { state.hidden = !state.hidden; syncToggle(); };
      wrap.append(openButton, toggleButton);
      el.appendChild(wrap);
      syncToggle();
      return () => wrap.remove();
    });
    ctx.system.log("声阅 Mini v1.3.0 已启动：支持加号面板隐藏听书窗、分段预生成、连续播放、作用域 CSS 和受限语气词预处理");
    return () => { css(); stop(); };
  },
};
