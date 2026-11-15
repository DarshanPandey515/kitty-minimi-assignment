import { useState } from "react";
import { Bot, Cat } from "lucide-react";
import { ChatApp } from "@/components/agents/chat-app";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageGroup,
  MessageHeader,
  MessageTyping,
} from "@/components/agents/message";
import { MessageBubble, MessageBubbleContent } from "@/components/agents/message-bubble";
import { StreamingResponse } from "@/components/agents/streaming-response";
import { AgentActivity } from "@/components/agents/agent-activity";
import { MessageScroller } from "@/components/agents/message-scroller";
import { PromptInput } from "@/components/agents/prompt-input";

type Source = { query: string; title: string; url: string; published_at: string | null };
type SearchActivity = { id: string; type: "search"; query: string; results?: { id: string; title: string; domain: string; url: string }[] };
type Msg = { role: "user" | "assistant"; text: string; sources?: Source[]; activity?: SearchActivity[] };

const SID_KEY = "agent.sessionId";

export function App() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const patchLast = (fn: (m: Msg) => Msg) => setMsgs((ms) => ms.map((m, i) => (i === ms.length - 1 ? fn(m) : m)));

  async function send(message: string) {
    if (!message.trim() || busy) return;
    setInput("");
    setBusy(true);
    setStatus("Thinking…");
    setMsgs((ms) => [...ms, { role: "user", text: message }, { role: "assistant", text: "", sources: [] }]);
    let searches = 0;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: localStorage.getItem(SID_KEY) ?? "", message }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const sid = res.headers.get("x-session-id");
      if (sid) localStorage.setItem(SID_KEY, sid);
      if (!res.body) throw new Error("No response stream");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (; ;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const event = /^event: (.+)$/m.exec(raw)?.[1];
          const data = JSON.parse(/^data: (.+)$/m.exec(raw)?.[1] ?? "{}");
          if (event === "tool") {
            if (!data.results) {
              searches++;
              setStatus(`Searching ${searches} ${searches === 1 ? "query" : "queries"}…`);
              patchLast((m) => ({ ...m, activity: [...(m.activity ?? []), { id: `search-${(m.activity ?? []).length}`, type: "search", query: data.query }] }));
            } else {
              patchLast((m) => {
                const activity = [...(m.activity ?? [])];
                const pending = activity.find((item) => item.query === data.query && !item.results);
                if (pending) pending.results = data.results.map((result: Omit<Source, "query" | "published_at">) => ({
                  id: result.url,
                  title: result.title,
                  domain: new URL(result.url).hostname,
                  url: result.url,
                }));
                return {
                  ...m,
                  activity,
                  sources: [...(m.sources ?? []), ...data.results.map((r: Omit<Source, "query">) => ({ ...r, query: data.query }))],
                };
              });
            }
          } else if (event === "token") {
            setStatus("Writing…");
            patchLast((m) => ({ ...m, text: m.text + data.text }));
          } else if (event === "error") patchLast((m) => ({ ...m, text: m.text + `\n[Error: ${data.message}]` }));
        }
      }
    } catch (err) {
      patchLast((m) => ({ ...m, text: m.text + `\n[Error: ${(err as Error).message}]` }));
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  return (
    <main className="mx-auto flex h-dvh w-full max-w-4xl flex-col p-3 sm:p-6">
      <header className="flex items-center gap-3 px-2">
        {/* <span className="grid size-10 place-items-center rounded-2xl bg-primary text-primary-foreground"><Cat className="size-5" /></span> */}
        <div><h1 className="font-semibold tracking-tighter">Kitty</h1>

          {/* <p className="text-xs text-muted-foreground">Your curious, context-aware assistant</p> */}

        </div>
      </header>
      <ChatApp className="flex min-h-0 flex-1 flex-col rounded-2xl">
        <MessageScroller busy={busy} label="Kitty conversation" className="min-h-0 flex-1" viewportClassName="h-full" contentClassName="mx-auto w-full max-w-3xl gap-5 p-4 sm:p-6">
          {msgs.length === 0 ? (
            <div className="grid h-full place-content-center justify-items-center gap-3 text-center">
              <span className="grid size-10 place-items-center rounded-2xl bg-primary text-primary-foreground"><Cat className="size-5" /></span>
              <div><p className="font-medium">What’s on your mind?</p><p className="mt-1 text-sm text-muted-foreground">Ask Kitty anything. She's curious assistant.</p></div>
            </div>
          ) : msgs.map((m, i) => (
            <Message key={i} from={m.role} animateIn={i >= msgs.length - 2}>
              {m.role === "assistant" && <MessageAvatar className="bg-muted"><Cat /></MessageAvatar>}
              <MessageContent>
                <MessageHeader>{m.role === "user" ? "You" : "Kitty"}</MessageHeader>
                {m.role === "user" ? (
                  <MessageBubble variant="solid">
                    <MessageBubbleContent>{m.text}</MessageBubbleContent>
                  </MessageBubble>
                ) : (
                  <>
                    {!!m.activity?.length && <AgentActivity
                      items={m.activity}
                      contentType="search"
                      status={busy && i === msgs.length - 1 ? "working" : "complete"}
                      activeLabel={m.activity.at(-1)?.query ? `Searching “${m.activity.at(-1)?.query}”…` : "Searching the web…"}
                      summary={`${m.activity.map((item) => item.query).join(" · ")} · ${m.sources?.length ?? 0} sources`}
                      className="mb-2"
                    />}
                    <StreamingResponse
                      status={busy && i === msgs.length - 1 ? "streaming" : m.text.includes("\n[Error:") ? "error" : "complete"}
                      copyText={m.text}
                      announce={false}
                      showFeedback={false}
                      sources={m.sources?.map((source, index) => ({
                        id: `${index}-${source.url}`,
                        title: source.title,
                        domain: [source.published_at, source.query].filter(Boolean).join(" · "),
                        url: source.url,
                      }))}
                      contentClassName="px-1"
                    >
                      {m.text || (busy && i === msgs.length - 1 ? <MessageTyping label="Kitty is responding" /> : null)}
                    </StreamingResponse>
                  </>
                )}
              </MessageContent>
            </Message>
          ))}
        </MessageScroller>
        <MessageGroup className="border-t border-border/70 bg-background/80 p-3 sm:p-4">
          {status && <p className="mx-auto mb-2 w-full max-w-3xl px-1 text-xs text-muted-foreground">{status}</p>}
          <PromptInput className="mx-auto w-full max-w-3xl" value={input} onValueChange={setInput} onSubmit={(value) => void send(value)} loading={busy} placeholder="Message Kitty…" aria-label="Message Kitty" />
        </MessageGroup>
      </ChatApp>
    </main>
  );
}
