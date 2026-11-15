import { useEffect, useRef, useState } from "react";

type Source = { query: string; title: string; url: string; published_at: string | null };
type Msg = { role: "user" | "assistant"; text: string; sources?: Source[]; meta?: string };

const SID_KEY = "agent.sessionId";

export function App() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, status]);

  const patchLast = (fn: (m: Msg) => Msg) => setMsgs((ms) => ms.map((m, i) => (i === ms.length - 1 ? fn(m) : m)));

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    setStatus("thinking…");
    setMsgs((ms) => [...ms, { role: "user", text: message }, { role: "assistant", text: "", sources: [] }]);

    let searches = 0;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: localStorage.getItem(SID_KEY) ?? "", message }),
      });
      const sid = res.headers.get("x-session-id");
      if (sid) localStorage.setItem(SID_KEY, sid);
      if (!res.body) throw new Error("no stream");

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const event = /^event: (.+)$/m.exec(raw)?.[1];
          const data = JSON.parse(/^data: (.+)$/m.exec(raw)?.[1] ?? "{}");
          if (event === "plan") patchLast((m) => ({ ...m, meta: `${data.intent}${data.entities.length ? ` · ${data.entities.length} entities` : ""}` }));
          else if (event === "memory") patchLast((m) => ({ ...m, meta: `${m.meta ?? ""} · mem: ${data.turnCount} turns, ${data.claimCount} claims` }));
          else if (event === "tool") {
            searches++;
            setStatus(`searching ${searches} ${searches === 1 ? "query" : "queries"}…`);
            patchLast((m) => ({ ...m, sources: [...(m.sources ?? []), ...data.results.map((r: any) => ({ ...r, query: data.query }))] }));
          } else if (event === "token") {
            setStatus("writing…");
            patchLast((m) => ({ ...m, text: m.text + data.text }));
          } else if (event === "error") patchLast((m) => ({ ...m, text: m.text + `\n[error: ${data.message}]` }));
        }
      }
    } catch (err) {
      patchLast((m) => ({ ...m, text: m.text + `\n[error: ${(err as Error).message}]` }));
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  return (
    <>
      <div className="list">
        {msgs.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.text || (m.role === "assistant" && busy && i === msgs.length - 1 ? "…" : "")}
            {m.role === "assistant" && m.meta && <div className="meta">{m.meta}</div>}
            {!!m.sources?.length && (
              <details>
                <summary>Sources ({m.sources.length})</summary>
                <ul>
                  {m.sources.map((s, j) => (
                    <li key={j}>
                      {s.title} · {s.published_at ?? "undated"} · <a href={s.url} target="_blank" rel="noreferrer">{s.url}</a>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="status">{status}</div>
      <div className="composer">
        <textarea
          rows={2}
          value={input}
          placeholder="Ask something…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
        />
        <button onClick={() => void send()} disabled={busy || !input.trim()}>Send</button>
      </div>
    </>
  );
}
