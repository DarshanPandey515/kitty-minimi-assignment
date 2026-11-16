import { lazy, Suspense, useEffect, useState, useMemo } from "react";
import { MessageSquare, Plus, Trash2 } from "lucide-react";
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
import PixelCat from "./components/kitty-avatar/avatar";

const ReactMarkdown = lazy(() => import("react-markdown"));

type Source = { query: string; title: string; url: string; published_at: string | null };
type SearchActivity = {
  id: string;
  type: "search";
  query: string;
  results?: { id: string; title: string; domain: string; url: string }[];
};
type Msg = { role: "user" | "assistant"; text: string; sources?: Source[]; activity?: SearchActivity[] };
type Conversation = { id: string; title: string; updated_at: string; turn_count: number };

function conversationIdFromPath() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  return parts.length === 1 ? decodeURIComponent(parts[0]) : "";
}

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

  function resetDraft() {
    setSessionId("");
    setMsgs([]);
    setInput("");
    setStatus("");
  }

  function startNewConversation() {
    if (busy) return;
    if (window.location.pathname !== "/") window.history.pushState({}, "", "/");
    resetDraft();
  }

  async function readConversation(id: string) {
    const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("Could not load conversation");
    return await response.json() as { role: "user" | "assistant"; text: string }[];
  }

  async function openConversation(id: string) {
    if (busy || id === sessionId) return;
    const turns = await readConversation(id);
    if (!turns) throw new Error("Conversation not found");
    setSessionId(id);
    setMsgs(turns.map(({ role, text }) => ({ role, text })));
    setInput("");
    window.history.pushState({}, "", `/${encodeURIComponent(id)}`);
  }

  async function removeConversation(id: string) {
    if (!window.confirm("Delete this conversation? This cannot be undone.")) return;
    const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) throw new Error("Could not delete conversation");
    const remaining = await refreshThreads();
    if (id === sessionId) {
      if (remaining.length) {
        const next = remaining[0];
        const turns = await readConversation(next.id);
        if (turns) {
          setSessionId(next.id);
          setMsgs(turns.map(({ role, text }) => ({ role, text })));
          window.history.replaceState({}, "", `/${encodeURIComponent(next.id)}`);
        } else {
          window.history.replaceState({}, "", "/");
          resetDraft();
        }
      } else {
        window.history.replaceState({}, "", "/");
        resetDraft();
      }
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      try {
        await refreshThreads();
        const id = conversationIdFromPath();
        if (!id) {
          if (!cancelled) resetDraft();
          return;
        }
        const turns = await readConversation(id);
        if (!turns) {
          window.history.replaceState({}, "", "/");
          if (!cancelled) resetDraft();
          return;
        }
        if (!cancelled) {
          setSessionId(id);
          setMsgs(turns.map(({ role, text }) => ({ role, text })));
        }
      } catch (error) {
        if (!cancelled) setStatus((error as Error).message);
      } finally {
        if (!cancelled) setThreadsLoading(false);
      }
    }
    void initialize();
    const onPopState = () => {
      const id = conversationIdFromPath();
      if (!id) { resetDraft(); return; }
      void readConversation(id).then((turns) => {
        if (turns) {
          setSessionId(id);
          setMsgs(turns.map(({ role, text }) => ({ role, text })));
        } else {
          window.history.replaceState({}, "", "/");
          resetDraft();
        }
      }).catch((error) => setStatus(error.message));
    };
    window.addEventListener("popstate", onPopState);
    return () => { cancelled = true; window.removeEventListener("popstate", onPopState); };
  }, []);

  const sidebarItems: SidebarResource[] = threads.map((thread) => ({ id: thread.id, label: thread.title, kind: "file" }));
  const patchLast = (fn: (m: Msg) => Msg) =>
    setMsgs((ms) => ms.map((m, i) => (i === ms.length - 1 ? fn(m) : m)));

  async function send(message: string) {
    if (!message.trim() || busy) return;
    const requestSessionId = sessionId || crypto.randomUUID();
    setInput("");
    setBusy(true);
    setStatus("Thinking…");
    setMsgs((ms) => [...ms, { role: "user", text: message }, { role: "assistant", text: "", sources: [] }]);
    let searches = 0;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: requestSessionId, message }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const sid = res.headers.get("x-session-id");
      if (sid) {
        setSessionId(sid);
        if (!sessionId) window.history.pushState({}, "", `/${encodeURIComponent(sid)}`);
      }
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
          <div className="relative flex items-center gap-3">
            <div
              className="size-8 shrink-0"
              style={{ filter: "drop-shadow(0 4px 8px rgb(251 113 133 / 0.3))" }}
            >
              <PixelCat className="w-full" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="font-semibold tracking-tighter">Kitty</h1>
              </div>
              <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                A curious assistant.
              </p>
            </div>
          </div>
        </div>

        <div className="flex h-[32dvh] min-h-40 flex-col overflow-hidden rounded-2xl border border-border/70 bg-card p-3 lg:h-auto lg:min-h-0 lg:flex-1">
          <button type="button" disabled={busy || threadsLoading} onClick={startNewConversation}
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
            <div className="grid h-full place-content-center justify-items-center text-center">
              <span className="grid size-10 place-items-center rounded-2xl text-primary-foreground">
                <PixelCat className="w-7" />
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
                    <PixelCat className="w-5" />
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
                        {m.text ? (
                          <Suspense fallback={null}>
                            <ReactMarkdown>{m.text}</ReactMarkdown>
                          </Suspense>
                        ) : busy && i === msgs.length - 1 ? (
                            <MessageTyping label="Kitty is responding" />
                          ) : null}
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
