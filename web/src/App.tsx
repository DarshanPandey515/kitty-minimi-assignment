import { useState } from "react";
import { Cat } from "lucide-react";
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

/* -------------------------------------------------------------------------- */
/*  Pixel kitty                                                               */
/* -------------------------------------------------------------------------- */

const PIXELS = [
  "................",
  "..##........##..",
  "..####....####..",
  "..#PP#....#PP#..",
  "..#PPPP##PPPP#..",
  ".#FFFFFFFFFFFF#.",
  ".#FFEEFFFFEEFF#.",
  ".#FFEWFFFFEWFF#.",
  ".#FFFFFPPFFFFF#.",
  ".#FFFFFPPFFFFF#.",
  ".#FFFFFFFFFFFF#.",
  "..#FFFFFFFFFF#..",
  "..#FFFFFFFFFF#..",
  "...##########...",
  "................",
  "................",
];

const PIXEL_COLORS: Record<string, string> = {
  "#": "#3b2a5a", // outline — deep violet
  F: "#fbbf24", // fur — amber
  P: "#fb7185", // ears + nose — pink
  E: "#2a1a3f", // eyes
  W: "#ffffff", // eye shine
};

function PixelCat({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`grid ${className}`}
      style={{ gridTemplateColumns: "repeat(16, 1fr)" }}
    >
      {PIXELS.flatMap((row, y) =>
        [...row].map((ch, x) => (
          <span
            key={`${x}-${y}`}
            className="aspect-square"
            style={{ background: PIXEL_COLORS[ch] ?? "transparent" }}
          />
        )),
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Catalog                                                                   */
/* -------------------------------------------------------------------------- */

type CatalogItem = { emoji: string; title: string; desc: string; tint: string; prompt: string };

const CATALOG: CatalogItem[] = [
  {
    emoji: "🔎",
    title: "Search the web",
    desc: "Fresh answers with sources",
    tint: "bg-sky-500/15",
    prompt: "Search the web for the latest AI news and summarize the top 3 stories with sources.",
  },
  {
    emoji: "🧶",
    title: "Explain simply",
    desc: "Complex idea, plain words",
    tint: "bg-fuchsia-500/15",
    prompt: "Explain how transformers work, like I'm five.",
  },
  {
    emoji: "📝",
    title: "Summarize",
    desc: "Long text → key points",
    tint: "bg-amber-500/15",
    prompt: "Summarize the following text into five bullet points: ",
  },
  {
    emoji: "💡",
    title: "Brainstorm",
    desc: "Ten ideas, fast",
    tint: "bg-emerald-500/15",
    prompt: "Brainstorm 10 names for a cozy cat-themed note-taking app.",
  },
  {
    emoji: "🧪",
    title: "Debug code",
    desc: "Find the bug, explain it",
    tint: "bg-violet-500/15",
    prompt: "Review this code and tell me what's wrong: ",
  },
];

/* -------------------------------------------------------------------------- */
/*  App                                                                       */
/* -------------------------------------------------------------------------- */

type Source = { query: string; title: string; url: string; published_at: string | null };
type SearchActivity = {
  id: string;
  type: "search";
  query: string;
  results?: { id: string; title: string; domain: string; url: string }[];
};
type Msg = { role: "user" | "assistant"; text: string; sources?: Source[]; activity?: SearchActivity[] };

const SID_KEY = "agent.sessionId";

export function App() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const patchLast = (fn: (m: Msg) => Msg) =>
    setMsgs((ms) => ms.map((m, i) => (i === ms.length - 1 ? fn(m) : m)));

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
              patchLast((m) => ({
                ...m,
                activity: [
                  ...(m.activity ?? []),
                  { id: `search-${(m.activity ?? []).length}`, type: "search", query: data.query },
                ],
              }));
            } else {
              patchLast((m) => {
                const activity = [...(m.activity ?? [])];
                const pending = activity.find((item) => item.query === data.query && !item.results);
                if (pending)
                  pending.results = data.results.map(
                    (result: Omit<Source, "query" | "published_at">) => ({
                      id: result.url,
                      title: result.title,
                      domain: new URL(result.url).hostname,
                      url: result.url,
                    }),
                  );
                return {
                  ...m,
                  activity,
                  sources: [
                    ...(m.sources ?? []),
                    ...data.results.map((r: Omit<Source, "query">) => ({ ...r, query: data.query })),
                  ],
                };
              });
            }
          } else if (event === "token") {
            setStatus("Writing…");
            patchLast((m) => ({ ...m, text: m.text + data.text }));
          } else if (event === "error")
            patchLast((m) => ({ ...m, text: m.text + `\n[Error: ${data.message}]` }));
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
    <main className="mx-auto flex h-dvh w-full max-w-6xl flex-col gap-3 p-3 sm:p-6 lg:flex-row">
      {/* ------------------------------- Left rail ------------------------------ */}
      <aside className="flex shrink-0 flex-col gap-3 lg:w-80">
        {/* Kitty card */}
        <div className="relative overflow-hidden rounded-2xl border border-border/70 bg-card p-4">
          <div
            aria-hidden
            className="pointer-events-none absolute -left-12 -top-12 size-40 rounded-full bg-fuchsia-400/30 blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-14 -right-6 size-40 rounded-full bg-cyan-400/30 blur-3xl"
          />
          <div className="relative flex items-center gap-4 lg:flex-col lg:items-start">
            <div
              className="shrink-0"
              style={{ filter: "drop-shadow(0 10px 20px rgb(251 113 133 / 0.35))" }}
            >
              <PixelCat className="w-24 lg:w-28" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="font-semibold tracking-tighter">Kitty</h1>
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                  online
                </span>
              </div>
              <p className="mt-1 text-xs leading-snug text-muted-foreground">
                A curious, context-aware assistant. She searches before she speaks.
              </p>
            </div>
          </div>
        </div>

        {/* Catalog of tiny cards */}
        <div className="scrollbar-hide -mx-1 flex gap-2 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
          <p className="hidden px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground lg:block">
            Catalog
          </p>
          {CATALOG.map((item) => (
            <button
              key={item.title}
              type="button"
              disabled={busy}
              onClick={() => void send(item.prompt)}
              className="group flex w-48 shrink-0 items-start gap-3 rounded-xl border border-border/70 bg-card p-3 text-left transition hover:-translate-y-0.5 hover:border-border hover:bg-accent disabled:pointer-events-none disabled:opacity-50 lg:w-full"
            >
              <span className={`grid size-8 shrink-0 place-items-center rounded-lg text-base ${item.tint}`}>
                {item.emoji}
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-medium">{item.title}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                  {item.desc}
                </span>
              </span>
            </button>
          ))}
        </div>
      </aside>

      {/* ------------------------------- Chat panel ----------------------------- */}
      <ChatApp className="flex min-h-0 flex-1 flex-col rounded-2xl">
        <MessageScroller
          busy={busy}
          label="Kitty conversation"
          className="min-h-0 flex-1"
          viewportClassName="h-full"
          contentClassName="mx-auto w-full max-w-3xl gap-5 p-4 sm:p-6"
        >
          {msgs.length === 0 ? (
            <div className="grid h-full place-content-center justify-items-center gap-3 text-center">
              <span className="grid size-10 place-items-center rounded-2xl bg-primary text-primary-foreground">
                <Cat className="size-5" />
              </span>
              <div>
                <p className="font-medium">What’s on your mind?</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Ask Kitty anything. She's a curious assistant.
                </p>
              </div>
            </div>
          ) : (
            msgs.map((m, i) => (
              <Message key={i} from={m.role} animateIn={i >= msgs.length - 2}>
                {m.role === "assistant" && (
                  <MessageAvatar className="bg-muted">
                    <Cat />
                  </MessageAvatar>
                )}
                <MessageContent>
                  <MessageHeader>{m.role === "user" ? "You" : "Kitty"}</MessageHeader>
                  {m.role === "user" ? (
                    <MessageBubble variant="solid">
                      <MessageBubbleContent>{m.text}</MessageBubbleContent>
                    </MessageBubble>
                  ) : (
                    <>
                      {!!m.activity?.length && (
                        <AgentActivity
                          items={m.activity}
                          contentType="search"
                          status={busy && i === msgs.length - 1 ? "working" : "complete"}
                          activeLabel={
                            m.activity.at(-1)?.query
                              ? `Searching “${m.activity.at(-1)?.query}”…`
                              : "Searching the web…"
                          }
                          summary={`${m.activity.map((item) => item.query).join(" · ")} · ${m.sources?.length ?? 0} sources`}
                          className="mb-2"
                        />
                      )}
                      <StreamingResponse
                        status={
                          busy && i === msgs.length - 1
                            ? "streaming"
                            : m.text.includes("\n[Error:")
                              ? "error"
                              : "complete"
                        }
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
                        {m.text ||
                          (busy && i === msgs.length - 1 ? (
                            <MessageTyping label="Kitty is responding" />
                          ) : null)}
                      </StreamingResponse>
                    </>
                  )}
                </MessageContent>
              </Message>
            ))
          )}
        </MessageScroller>
        <MessageGroup className="border-t border-border/70 bg-background/80 p-3 sm:p-4">
          {status && (
            <p className="mx-auto mb-2 w-full max-w-3xl px-1 text-xs text-muted-foreground">
              {status}
            </p>
          )}
          <PromptInput
            className="mx-auto w-full max-w-3xl"
            value={input}
            onValueChange={setInput}
            onSubmit={(value) => void send(value)}
            loading={busy}
            placeholder="Message Kitty…"
            aria-label="Message Kitty"
          />
        </MessageGroup>
      </ChatApp>
    </main>
  );
}