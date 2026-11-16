import { useEffect, useState } from "react";
import { Cat, MessageSquare, Plus, Trash2 } from "lucide-react";
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
import { AISidebar, type SidebarResource } from "@/components/agents/ai-sidebar";

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
type Conversation = { id: string; title: string; updated_at: string; turn_count: number };

const SID_KEY = "agent.sessionId";

export function App() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [threads, setThreads] = useState<Conversation[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [threadsLoading, setThreadsLoading] = useState(true);

  async function refreshThreads() {
    const response = await fetch("/api/conversations");
    if (!response.ok) throw new Error("Could not load conversations");
    const next = await response.json() as Conversation[];
    setThreads(next);
    return next;
  }

  async function createConversation() {
    const response = await fetch("/api/conversations", { method: "POST" });
    if (!response.ok) throw new Error("Could not create conversation");
    const created = await response.json() as { id: string };
    setSessionId(created.id);
    localStorage.setItem(SID_KEY, created.id);
    setMsgs([]);
    await refreshThreads();
  }

  async function openConversation(id: string) {
    if (busy || id === sessionId) return;
    const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error("Could not load conversation");
    const turns = await response.json() as { role: "user" | "assistant"; text: string }[];
    setSessionId(id);
    localStorage.setItem(SID_KEY, id);
    setMsgs(turns.map(({ role, text }) => ({ role, text })));
    setInput("");
  }

  async function removeConversation(id: string) {
    if (!window.confirm("Delete this conversation? This cannot be undone.")) return;
    const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) throw new Error("Could not delete conversation");
    const remaining = await refreshThreads();
    if (id === sessionId) {
      if (remaining.length) await openConversation(remaining[0].id);
      else await createConversation();
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      try {
        let all = await refreshThreads();
        const savedId = localStorage.getItem(SID_KEY);
        let active = all.find((item) => item.id === savedId);
        if (!active && all.length) active = all[0];
        if (!active) {
          const response = await fetch("/api/conversations", { method: "POST" });
          if (!response.ok) throw new Error("Could not create conversation");
          const created = await response.json() as { id: string };
          all = await refreshThreads();
          active = all.find((item) => item.id === created.id) ?? { id: created.id, title: "New conversation", updated_at: "", turn_count: 0 };
        }
        const response = await fetch(`/api/conversations/${encodeURIComponent(active.id)}`);
        if (!response.ok) throw new Error("Could not load conversation");
        const turns = await response.json() as { role: "user" | "assistant"; text: string }[];
        if (!cancelled) {
          setSessionId(active.id);
          localStorage.setItem(SID_KEY, active.id);
          setMsgs(turns.map(({ role, text }) => ({ role, text })));
        }
      } catch (error) {
        if (!cancelled) setStatus((error as Error).message);
      } finally {
        if (!cancelled) setThreadsLoading(false);
      }
    }
    void initialize();
    return () => { cancelled = true; };
  }, []);

  const sidebarItems: SidebarResource[] = threads.map((thread) => ({ id: thread.id, label: thread.title, kind: "file" }));
  const patchLast = (fn: (m: Msg) => Msg) =>
    setMsgs((ms) => ms.map((m, i) => (i === ms.length - 1 ? fn(m) : m)));

  async function send(message: string) {
    if (!message.trim() || busy || !sessionId) return;
    setInput("");
    setBusy(true);
    setStatus("Thinking…");
    setMsgs((ms) => [...ms, { role: "user", text: message }, { role: "assistant", text: "", sources: [] }]);
    let searches = 0;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const sid = res.headers.get("x-session-id");
      if (sid) { setSessionId(sid); localStorage.setItem(SID_KEY, sid); }
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
          else if (event === "done") void refreshThreads();
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
      <aside className="flex shrink-0 flex-col gap-3 lg:min-h-0 lg:w-80">
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

        <div className="flex h-[32dvh] min-h-40 flex-col overflow-hidden rounded-2xl border border-border/70 bg-card p-3 lg:h-auto lg:min-h-0 lg:flex-1">
          <button type="button" disabled={busy || threadsLoading} onClick={() => void createConversation().catch((error) => setStatus(error.message))}
            className="mb-3 inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50">
            <Plus className="size-4" /> New conversation
          </button>
          <p className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Conversations</p>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <AISidebar
              items={sidebarItems}
              activeId={sessionId}
              onActiveChange={(id) => void openConversation(id).catch((error) => setStatus(error.message))}
              renderIcon={() => <MessageSquare className="size-4" />}
              ariaLabel="Conversation threads"
              className="w-full"
              renderMenu={(item, controls) => (
                <button type="button" onClick={() => { controls.close(); void removeConversation(item.id).catch((error) => setStatus(error.message)); }}
                  className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-destructive outline-none transition-colors hover:bg-destructive/10 focus-visible:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring">
                  <Trash2 className="size-3.5" /> Delete conversation
                </button>
              )}
            />
            {!threadsLoading && !threads.length && <p className="px-2 py-4 text-center text-xs text-muted-foreground">No conversations yet.</p>}
          </div>
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
            loading={busy || threadsLoading}
            placeholder="Message Kitty…"
            aria-label="Message Kitty"
          />
        </MessageGroup>
      </ChatApp>
    </main>
  );
}
