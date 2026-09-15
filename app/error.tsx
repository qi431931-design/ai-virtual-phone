"use client";

import { useEffect, useState } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [details, setDetails] = useState("");

  useEffect(() => {
    setDetails(`${error?.name}: ${error?.message}\n\nStack:\n${error?.stack || "No stack"}`);
  }, [error]);

  return (
    <div style={{ padding: 24, background: "#0c0c12", color: "#f87171", minHeight: "100dvh", fontFamily: "monospace", fontSize: 13 }}>
      <h2 style={{ color: "#fff", fontSize: 18, marginBottom: 12 }}>应用启动异常排查</h2>
      <p style={{ color: "#94a3b8", marginBottom: 16 }}>请把下面的报错信息截图或复制发给小坊：</p>
      <pre style={{ background: "rgba(255,255,255,0.05)", padding: 16, borderRadius: 8, overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", border: "1px solid rgba(248,113,113,0.3)" }}>
        {details || error?.message || "未知错误"}
      </pre>
      <button
        onClick={() => reset()}
        style={{ marginTop: 20, padding: "10px 24px", background: "#3b82f6", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 600 }}
      >
        重试进入
      </button>
    </div>
  );
}
