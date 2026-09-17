export default {
  manifest: {
    id: "universal-voice-input-pro",
    name: "通用语音转文字 (ASR Pro)",
    apiVersion: 1,
    version: "1.5.5",
    author: "小坊",
    description: "长按打字框说话、上滑取消、60s倒计时、悬浮球拖拽贴边与极速转写。",
    permissions: ["chat.read"],
    settings: [
      {
        key: "presetProvider",
        label: "服务商预设",
        type: "select",
        default: "siliconflow",
        options: [
          { value: "siliconflow", label: "SiliconFlow 硅基流动 (国内推荐·免翻)" },
          { value: "groq", label: "Groq Whisper (海外直连·极速)" },
          { value: "openai", label: "OpenAI 官方 (whisper-1)" },
          { value: "custom", label: "自定义 / 第三方中转站" }
        ]
      },
      {
        key: "apiKey",
        label: "API Key (密钥)",
        type: "text",
        default: ""
      },
      {
        key: "apiBase",
        label: "API Base URL",
        type: "text",
        default: "https://api.siliconflow.cn/v1"
      },
      {
        key: "modelName",
        label: "ASR 语音模型",
        type: "text",
        default: "FunAudioLLM/SenseVoiceSmall"
      },
      {
        key: "language",
        label: "识别语言 (SenseVoice 选 auto)",
        type: "select",
        default: "auto",
        options: [
          { value: "auto", label: "自动识别 (SenseVoice/Whisper 推荐)" },
          { value: "zh", label: "中文" },
          { value: "en", label: "英语" },
          { value: "ja", label: "日语" },
          { value: "yue", label: "粤语" }
        ]
      },
      {
        key: "cleanSenseVoiceTags",
        label: "自动清洗 SenseVoice 标签",
        type: "boolean",
        default: true
      },
      {
        key: "showFab",
        label: "开启悬浮麦克风 (支持拖拽贴边)",
        type: "boolean",
        default: false
      },
      {
        key: "autoSend",
        label: "转写后直接发送给角色",
        type: "boolean",
        default: false
      }
    ]
  },

  setup(ctx) {
    let currentSessionId = null;
    let mediaRecorder = null;
    let audioChunks = [];
    let isRecording = false;
    let recordStartTime = 0;
    let activeInputEl = null;
    let isCancelState = false;
    let startPointerY = 0;
    let timerTickId = null;

    const MAX_RECORD_SEC = 60;

    const PROVIDER_CONFIGS = {
      siliconflow: {
        base: "https://api.siliconflow.cn/v1",
        model: "FunAudioLLM/SenseVoiceSmall"
      },
      groq: {
        base: "https://api.groq.com/openai/v1",
        model: "whisper-large-v3-turbo"
      },
      openai: {
        base: "https://api.openai.com/v1",
        model: "whisper-1"
      }
    };

    ctx.hooks.on("session.opened", function (p) {
      if (p && p.sessionId) {
        currentSessionId = p.sessionId;
        updateUI();
      }
    });

    const applyProviderPreset = function (providerKey) {
      const cfg = PROVIDER_CONFIGS[providerKey];
      if (!cfg) return;
      ctx.system.settings.set("presetProvider", providerKey);
      ctx.system.settings.set("apiBase", cfg.base);
      ctx.system.settings.set("modelName", cfg.model);

      const allInputs = document.querySelectorAll("input[type='text'], input:not([type])");
      for (let i = 0; i < allInputs.length; i++) {
        const input = allInputs[i];
        const row = input.closest("div, label, tr");
        const rowText = row ? row.textContent : "";
        if (rowText.indexOf("Base URL") !== -1 || rowText.indexOf("API Base") !== -1) {
          input.value = cfg.base;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        } else if (rowText.indexOf("语音模型") !== -1 || rowText.indexOf("模型名称") !== -1) {
          input.value = cfg.model;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    };

    ctx.system.settings.onChange(function (key, val) {
      if (key === "presetProvider") {
        applyProviderPreset(val);
      }
    });

    ctx.ui.injectCSS(
      ".xf-pro-pressing { outline: 2px solid rgba(160, 160, 175, 0.7) !important; background: rgba(125, 125, 125, 0.08) !important; } " +
      ".xf-pro-recording { outline: 2px solid #ef4444 !important; box-shadow: 0 0 12px rgba(239, 68, 68, 0.6) !important; } " +
      ".xf-pro-capsule { position: fixed; top: 55px; left: 50%; transform: translateX(-50%) translateY(-10px); background: rgba(24, 24, 28, 0.94); color: #f4f4f5; border: 1px solid rgba(255, 255, 255, 0.15); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); padding: 8px 16px; border-radius: 9999px; display: none; align-items: center; gap: 10px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4); z-index: 100000; font-size: 13px; font-weight: 500; opacity: 0; transition: all 0.2s ease; user-select: none; pointer-events: none; } " +
      ".xf-pro-capsule.active { display: flex; opacity: 1; transform: translateX(-50%) translateY(0); } " +
      ".xf-pro-capsule.cancel-mode { background: rgba(185, 28, 28, 0.95) !important; border-color: rgba(239, 68, 68, 0.8) !important; } " +
      ".xf-pro-capsule.warn-mode { background: rgba(45, 30, 10, 0.95) !important; border-color: rgba(245, 158, 11, 0.8) !important; } " +
      ".xf-pro-wave { display: flex; align-items: center; gap: 3px; height: 14px; } " +
      ".xf-pro-wave span { width: 3px; height: 100%; background: #ef4444; border-radius: 3px; animation: xf-wave-anim 0.8s infinite ease-in-out; } " +
      ".xf-pro-wave span:nth-child(2) { animation-delay: 0.15s; height: 70%; } " +
      ".xf-pro-wave span:nth-child(3) { animation-delay: 0.3s; height: 100%; } " +
      "@keyframes xf-wave-anim { 0%, 100% { transform: scaleY(0.3); } 50% { transform: scaleY(1); } } " +
      ".xf-pro-fab-wrap { position: fixed; width: 44px; height: 44px; display: none; z-index: 9999; user-select: none; touch-action: none; } " +
      ".xf-pro-fab-mic { width: 100%; height: 100%; border-radius: 50%; background: rgba(30, 32, 38, 0.82); color: #e4e4e7; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 18px rgba(0, 0, 0, 0.38); cursor: grab; border: 1px solid rgba(255, 255, 255, 0.18); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); transition: transform 0.12s ease, background-color 0.2s ease; } " +
      ".xf-pro-fab-mic:active { cursor: grabbing; } " +
      ".xf-pro-fab-mic.is-rec { background: rgba(220, 38, 38, 0.9) !important; border-color: rgba(239, 68, 68, 0.7) !important; color: #ffffff !important; }"
    );

    const capsuleEl = document.createElement("div");
    capsuleEl.className = "xf-pro-capsule";
    capsuleEl.innerHTML = '<div class="xf-pro-wave"><span></span><span></span><span></span></div><span id="xf-capsule-txt">正在录音</span>';
    document.body.appendChild(capsuleEl);
    const capsuleTxt = capsuleEl.querySelector("#xf-capsule-txt");

    const fabWrap = document.createElement("div");
    fabWrap.className = "xf-pro-fab-wrap";
    fabWrap.innerHTML = '<div class="xf-pro-fab-mic" id="xf-fab-mic-btn"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" x1="12" y1="19" y2="22"></line></svg></div>';
    document.body.appendChild(fabWrap);

    fabWrap.style.left = (window.innerWidth - 56) + "px";
    fabWrap.style.top = (window.innerHeight - 130) + "px";

    let isDraggingFab = false;
    let dragStartPos = { x: 0, y: 0 };
    let hasMoved = false;

    const micBtn = fabWrap.querySelector("#xf-fab-mic-btn");

    const onFabPointerDown = function (e) {
      isDraggingFab = true;
      hasMoved = false;
      const clientX = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
      const clientY = e.clientY || (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
      dragStartPos = {
        x: clientX - fabWrap.offsetLeft,
        y: clientY - fabWrap.offsetTop
      };
      fabWrap.style.transition = "none";
      document.addEventListener("pointermove", onFabPointerMove);
      document.addEventListener("pointerup", onFabPointerUp);
    };

    const onFabPointerMove = function (e) {
      if (!isDraggingFab) return;
      const clientX = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
      const clientY = e.clientY || (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
      let nextX = clientX - dragStartPos.x;
      let nextY = clientY - dragStartPos.y;

      if (Math.abs(nextX - fabWrap.offsetLeft) > 3 || Math.abs(nextY - fabWrap.offsetTop) > 3) {
        hasMoved = true;
      }

      nextX = Math.max(8, Math.min(window.innerWidth - 52, nextX));
      nextY = Math.max(50, Math.min(window.innerHeight - 60, nextY));

      fabWrap.style.left = nextX + "px";
      fabWrap.style.top = nextY + "px";
    };

    const onFabPointerUp = function () {
      if (!isDraggingFab) return;
      isDraggingFab = false;
      document.removeEventListener("pointermove", onFabPointerMove);
      document.removeEventListener("pointerup", onFabPointerUp);

      const curX = fabWrap.offsetLeft;
      const mid = window.innerWidth / 2;
      const targetX = curX < mid ? 12 : window.innerWidth - 56;

      fabWrap.style.transition = "left 0.25s ease, top 0.25s ease";
      fabWrap.style.left = targetX + "px";

      if (!hasMoved) {
        if (!isRecording) {
          startRecording("float");
        } else {
          stopRecording(false);
        }
      }
    };

    micBtn.addEventListener("pointerdown", onFabPointerDown);

    const updateUI = function () {
      const showFab = ctx.system.settings.get("showFab") === true;
      const chatTextarea = document.querySelector(".chat-input-textarea");
      if (!showFab || !chatTextarea) {
        fabWrap.style.display = "none";
        return;
      }
      fabWrap.style.display = "block";
    };

    const uiCheckTimer = ctx.system.timers.setInterval(updateUI, 600);

    const getCleanKey = function () {
      const raw = (ctx.system.settings.get("apiKey") || "").trim();
      return raw.replace(/^Bearer\s+/i, "").replace(/[\r\n\t\s"']/g, "").trim();
    };

    const getBaseUrl = function () {
      const b = (ctx.system.settings.get("apiBase") || "").trim();
      if (!b) {
        const p = ctx.system.settings.get("presetProvider") || "siliconflow";
        return PROVIDER_CONFIGS[p] ? PROVIDER_CONFIGS[p].base : "https://api.siliconflow.cn/v1";
      }
      return b.replace(/\/+$/, "");
    };

    ctx.ui.slot("settings.section", function (container) {
      container.style.cssText = "margin-top:14px;padding:14px;background:rgba(125,125,125,0.08);border-radius:12px;border:1px solid rgba(125,125,125,0.15);";
      container.innerHTML = '<div style="font-size:13px;font-weight:600;margin-bottom:4px;">ASR 模型拉取与连通性诊断</div><div style="font-size:12px;opacity:0.75;margin-bottom:10px;">填入上方 Key 后点此测试，可自动校验并筛选可用语音模型：</div><button id="xf-diag-btn" style="width:100%;padding:9px;border-radius:6px;background:#2563eb;color:#fff;border:none;font-size:12px;font-weight:500;cursor:pointer;">拉取远程模型并测试连通性</button><div id="xf-diag-box" style="margin-top:10px;display:none;padding:10px;border-radius:8px;font-size:12px;white-space:pre-wrap;word-break:break-all;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);"></div>';

      const btn = container.querySelector("#xf-diag-btn");
      const resBox = container.querySelector("#xf-diag-box");

      btn.onclick = async function () {
        const key = getCleanKey();
        const base = getBaseUrl();
        resBox.style.display = "block";

        if (!key) {
          resBox.innerHTML = '<span style="color:#ef4444;">请先在上方设置项中填写 API Key</span>';
          return;
        }

        resBox.innerHTML = "正在请求 " + base + "/models ...";

        try {
          const res = await (window.fetch || ctx.system.fetch)(base + "/models", {
            method: "GET",
            headers: { Authorization: "Bearer " + key }
          });

          if (!res.ok) {
            const errTxt = await res.text();
            resBox.innerHTML = '<span style="color:#ef4444;">请求失败 [HTTP ' + res.status + ']</span><br>' + errTxt;
            return;
          }

          const data = await res.json();
          const list = data.data || [];
          const audioModels = list.filter(function (m) {
            const id = (m.id || "").toLowerCase();
            return id.indexOf("voice") !== -1 || id.indexOf("audio") !== -1 || id.indexOf("sense") !== -1 || id.indexOf("whisper") !== -1 || id.indexOf("funaudio") !== -1 || id.indexOf("speech") !== -1;
          });

          let out = '<span style="color:#10b981;">Key 校验通过！共获取到 ' + list.length + ' 个可用模型</span><br>';
          if (audioModels.length > 0) {
            out += "<br><b>检测到 ASR 模型 (点击选用)：</b><br>";
            for (let i = 0; i < audioModels.length; i++) {
              const m = audioModels[i];
              out += '<div class="xf-pick-item" data-id="' + m.id + '" style="padding:6px 8px;margin:5px 0;background:rgba(255,255,255,0.08);border-radius:6px;cursor:pointer;color:#60a5fa;display:flex;justify-content:space-between;align-items:center;"><span>' + m.id + '</span><span style="color:#a1a1aa;font-size:11px;">点击选用</span></div>';
            }
          } else {
            out += "<br>接口已连通，可直接使用默认推荐的模型名。<br>";
          }

          resBox.innerHTML = out;
          const pickItems = resBox.querySelectorAll(".xf-pick-item");
          for (let j = 0; j < pickItems.length; j++) {
            const item = pickItems[j];
            item.onclick = function () {
              const modelId = item.getAttribute("data-id");
              ctx.system.settings.set("modelName", modelId);
              const allInputs = document.querySelectorAll("input[type='text'], input:not([type])");
              for (let k = 0; k < allInputs.length; k++) {
                const input = allInputs[k];
                const row = input.closest("div, label, tr");
                const label = row ? row.textContent : "";
                if (label.indexOf("语音模型") !== -1 || label.indexOf("模型名称") !== -1) {
                  input.value = modelId;
                  input.dispatchEvent(new Event("input", { bubbles: true }));
                }
              }
              ctx.ui.toast("已选用模型: " + modelId);
            };
          }
        } catch (e) {
          resBox.innerHTML = '<span style="color:#ef4444;">网络异常：</span><br>' + (e.message || e);
        }
      };
    });

    const isChatRoomInput = function (el) {
      if (!el) return false;
      if (el.tagName === "SELECT" || el.tagName === "OPTION" || el.tagName === "BUTTON") return false;
      if (el.type === "checkbox" || el.type === "radio" || el.type === "password") return false;
      if (el.closest(".settings-container, .modal, [role='dialog'], .xf-pro-capsule, .plugin-settings, form, .xf-pro-fab-wrap")) {
        return false;
      }
      if (el.classList && el.classList.contains("chat-input-textarea")) return true;
      if (el.closest(".chat-input-bar, .chat-room-main-pane") && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
        return true;
      }
      return false;
    };

    let pressTimer = null;
    let triggerMode = "hold";

    const updateCountdownDisplay = function () {
      if (!isRecording) return;
      const elapsedSec = Math.floor((Date.now() - recordStartTime) / 1000);
      const remainingSec = Math.max(0, MAX_RECORD_SEC - elapsedSec);

      if (isCancelState) {
        capsuleTxt.textContent = "松开手指，取消录音";
        return;
      }

      if (remainingSec <= 10) {
        capsuleEl.classList.add("warn-mode");
        capsuleTxt.textContent = "剩余 " + remainingSec + "s 自动转写 (上滑取消)";
      } else {
        capsuleEl.classList.remove("warn-mode");
        if (triggerMode === "hold") {
          capsuleTxt.textContent = "录音中 " + elapsedSec + "s · 松手转写 (上滑取消)";
        } else {
          capsuleTxt.textContent = "录音中 " + elapsedSec + "s · 再次点击完成";
        }
      }

      if (elapsedSec >= MAX_RECORD_SEC) {
        ctx.ui.toast("已达 60s 最大时长，自动转写");
        stopRecording(false);
      }
    };

    const handleStart = function (e) {
      const target = e.target;
      if (!isChatRoomInput(target)) return;

      activeInputEl = target;
      isCancelState = false;
      startPointerY = e.clientY || (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
      activeInputEl.classList.add("xf-pro-pressing");

      clearTimeout(pressTimer);
      pressTimer = setTimeout(function () {
        if (activeInputEl) {
          activeInputEl.classList.remove("xf-pro-pressing");
          activeInputEl.classList.add("xf-pro-recording");
        }
        if (navigator.vibrate) navigator.vibrate(40);
        startRecording("hold");
      }, 350);
    };

    const handleMove = function (e) {
      if (!isRecording || triggerMode !== "hold") return;
      const curY = e.clientY || (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
      if (startPointerY - curY > 45) {
        if (!isCancelState) {
          isCancelState = true;
          capsuleEl.classList.add("cancel-mode");
          capsuleTxt.textContent = "松开手指，取消录音";
          if (navigator.vibrate) navigator.vibrate(20);
        }
      } else {
        if (isCancelState) {
          isCancelState = false;
          capsuleEl.classList.remove("cancel-mode");
          updateCountdownDisplay();
        }
      }
    };

    const handleEnd = function () {
      clearTimeout(pressTimer);
      if (activeInputEl) {
        activeInputEl.classList.remove("xf-pro-pressing");
        activeInputEl.classList.remove("xf-pro-recording");
      }
      if (isRecording && triggerMode === "hold") {
        stopRecording(isCancelState);
      }
    };

    document.addEventListener("pointerdown", handleStart, { capture: true, passive: true });
    document.addEventListener("pointermove", handleMove, { capture: true, passive: true });
    document.addEventListener("pointerup", handleEnd, { capture: true, passive: true });
    document.addEventListener("pointercancel", handleEnd, { capture: true, passive: true });

    const startRecording = async function (mode) {
      if (isRecording) return;
      triggerMode = mode || "hold";
      isCancelState = false;
      capsuleEl.classList.remove("cancel-mode", "warn-mode");

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioChunks = [];

        const mimeTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac", "audio/ogg"];
        let selectedMime = "";
        for (let i = 0; i < mimeTypes.length; i++) {
          if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(mimeTypes[i])) {
            selectedMime = mimeTypes[i];
            break;
          }
        }
        mediaRecorder = selectedMime ? new MediaRecorder(stream, { mimeType: selectedMime }) : new MediaRecorder(stream);

        mediaRecorder.ondataavailable = function (e) {
          if (e.data && e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.onstop = async function () {
          const tracks = stream.getTracks();
          for (let i = 0; i < tracks.length; i++) {
            tracks[i].stop();
          }
          clearInterval(timerTickId);

          if (isCancelState) {
            ctx.ui.toast("已取消录音");
            return;
          }

          const duration = Date.now() - recordStartTime;
          if (duration < 400) {
            ctx.ui.toast("说话时间太短");
            return;
          }
          const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
          await doUniversalTranscription(blob);
        };

        mediaRecorder.start(200);
        isRecording = true;
        recordStartTime = Date.now();

        clearInterval(timerTickId);
        timerTickId = setInterval(updateCountdownDisplay, 250);
        updateCountdownDisplay();

        if (micBtn) micBtn.classList.add("is-rec");
        capsuleEl.classList.add("active");
      } catch (err) {
        ctx.system.log("麦克风启动失败", err);
        ctx.ui.toast("无法开启麦克风，请检查权限");
        isRecording = false;
        capsuleEl.classList.remove("active");
      }
    };

    const stopRecording = function (cancel) {
      if (!isRecording) return;
      isCancelState = cancel === true;
      isRecording = false;
      clearInterval(timerTickId);
      capsuleEl.classList.remove("active", "cancel-mode", "warn-mode");

      if (micBtn) micBtn.classList.remove("is-rec");

      if (activeInputEl) {
        activeInputEl.classList.remove("xf-pro-pressing");
        activeInputEl.classList.remove("xf-pro-recording");
      }
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }
    };

    async function doUniversalTranscription(blob) {
      const key = getCleanKey();
      const base = getBaseUrl();
      const model = (ctx.system.settings.get("modelName") || "FunAudioLLM/SenseVoiceSmall").trim();
      const language = ctx.system.settings.get("language") || "auto";
      const cleanSense = ctx.system.settings.get("cleanSenseVoiceTags") !== false;
      const autoSend = ctx.system.settings.get("autoSend") === true;

      if (!key && base.indexOf("/") !== 0) {
        ctx.ui.toast("请在插件设置中填写 API Key！");
        return;
      }

      const toast = ctx.ui.toast("正在转写…", { durationMs: 0 });
      const abortCtrl = new AbortController();
      const timeoutId = setTimeout(function () {
        abortCtrl.abort();
      }, 15000);

      try {
        const formData = new FormData();
        let ext = "webm";
        if (blob.type.indexOf("mp4") !== -1) ext = "m4a";
        else if (blob.type.indexOf("ogg") !== -1) ext = "ogg";
        else if (blob.type.indexOf("aac") !== -1) ext = "aac";
        else if (blob.type.indexOf("wav") !== -1) ext = "wav";

        const audioFile = new File([blob], "speech." + ext, { type: blob.type || "audio/webm" });
        formData.append("file", audioFile);
        formData.append("model", model);

        const isSenseVoice = model.toLowerCase().indexOf("sensevoice") !== -1;
        if (!isSenseVoice && language && language !== "auto") {
          formData.append("language", language);
        }

        const headers = {};
        if (key) {
          headers["Authorization"] = "Bearer " + key;
        }

        // 兼容 /v1/audio/transcriptions 与 /audio/transcriptions
        let targetUrl = base;
        if (!targetUrl.endsWith("/audio/transcriptions")) {
          targetUrl = targetUrl + "/audio/transcriptions";
        }

        const res = await (window.fetch || ctx.system.fetch)(targetUrl, {
          method: "POST",
          headers: headers,
          body: formData,
          signal: abortCtrl.signal
        });

        clearTimeout(timeoutId);

        if (!res.ok) {
          const detail = await res.text();
          throw new Error("[HTTP " + res.status + "] " + detail);
        }

        const data = await res.json();
        let text = (data.text || data.result || (typeof data === "string" ? data : "")).trim();

        if (cleanSense) {
          text = text.replace(/<\|.*?\|>/g, "").trim();
        }

        if (!text) {
          ctx.ui.toast("未识别到清晰语音");
          return;
        }

        if (autoSend && currentSessionId) {
          ctx.data.messages.push({
            sessionId: currentSessionId,
            role: "user",
            content: text
          });
          ctx.ui.toast("已发送");
        } else {
          const target = activeInputEl || document.querySelector(".chat-input-textarea, textarea");
          if (target) {
            const oldVal = target.value || "";
            const nextVal = oldVal ? (oldVal + " " + text) : text;

            const proto = window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const desc = Object.getOwnPropertyDescriptor(proto, "value");
            const nativeSetter = desc ? desc.set : null;

            if (nativeSetter) {
              nativeSetter.call(target, nextVal);
            } else {
              target.value = nextVal;
            }

            target.dispatchEvent(new Event("input", { bubbles: true }));
            target.dispatchEvent(new Event("change", { bubbles: true }));
            target.focus();

            if (typeof target.setSelectionRange === "function") {
              const len = target.value.length;
              target.setSelectionRange(len, len);
            }

            target.style.height = "auto";
            target.style.height = Math.min(target.scrollHeight, 120) + "px";

            ctx.ui.toast("已填入输入框");
          } else {
            await navigator.clipboard.writeText(text);
            ctx.ui.toast("已转写：" + text);
          }
        }
      } catch (err) {
        clearTimeout(timeoutId);
        ctx.system.log("ASR 转写失败", err);
        if (err.name === "AbortError") {
          ctx.ui.toast("转写超时，请检查网络");
        } else {
          ctx.ui.toast("转写失败: " + (err.message || err));
        }
      } finally {
        toast.close();
      }
    }

    return function () {
      clearInterval(uiCheckTimer);
      clearInterval(timerTickId);
      document.removeEventListener("pointerdown", handleStart, { capture: true });
      document.removeEventListener("pointermove", handleMove, { capture: true });
      document.removeEventListener("pointerup", handleEnd, { capture: true });
      document.removeEventListener("pointercancel", handleEnd, { capture: true });
      if (capsuleEl && capsuleEl.parentElement) capsuleEl.parentElement.removeChild(capsuleEl);
      if (fabWrap && fabWrap.parentElement) fabWrap.parentElement.removeChild(fabWrap);
      if (isRecording) stopRecording(true);
    };
  }
};
