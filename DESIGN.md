# Design

[Problem](#1-problem) · [Architecture](#2-architecture) · [Decisions](#3-critical-design-decisions) · [Alternatives](#4-alternatives-considered) · [Evaluation](#5-evaluation) · [Next week](#6-what-id-do-with-another-week)

## 1. Problem

“Has Postgres hosting pricing changed since we last talked?” requires two pieces of evidence: what we discussed then and what a dated source says now. A present-day price alone can’t show a change. The agent needs to find the old answer, compare equivalent plans, and say when there isn’t enough evidence.

## 2. Architecture

The server saves the message, resolves supported dates in UTC, and asks Gemini for an intent and entities. It selects context from SQLite and, for semantic recall, can query a Qdrant index using local MiniLM embeddings. Gemini streams the answer and can call Tavily for current evidence. The server saves the reply before running extraction in the background. SQLite holds the transcript, claims, and pending work; Qdrant can be rebuilt from it.

## 3. Critical design decisions

- **Use the cheapest retrieval that fits the question.** Dates map to SQLite ranges. Text matches preserve exact terms and identifiers; vectors find paraphrases. Semantic recall merges ranked candidates with reciprocal rank fusion and loads the selected turns from SQLite. If embeddings or Qdrant fail, SQL still works.
- **Separate history from current evidence.** The router directs current questions to search and comparisons to both history and search. Ordinary chat and historical recall generally have no need to search; the synthesizer still decides whether to use its only tool. A separate structured decision can request one additional claim lookup before prose streams. If that decision fails, synthesis proceeds with the context already found.
- **Share claims across one owner’s threads.** Raw turns are scoped to the active thread; dated claims can carry facts across threads and link back to supporting turns. Topic claims can record what was asked before full extraction finishes. Pending indexing and extraction work is persisted and retried with backoff. Until it succeeds, same-thread context and SQL are available, but a new thread may lack the old answer’s details. This schema has no user boundary.

## 4. Alternatives considered

| Alternative | Why I chose differently |
| --- | --- |
| SQL alone or vectors alone | SQL handles dates and exact names well; vectors recover wording changes that SQL can miss. Keeping both lets date lookups avoid the vector path. |
| Remote embeddings | Local MiniLM removes a network request from semantic recall. It adds a model download and CPU work. |
| Give the model a memory tool | Server-selected context keeps date rules and thread scope in code and bounds extra lookup work before streaming. |

## 5. Evaluation

The [committed synthetic benchmark](bench/baseline-2026-11-16.json) compares SQL with MiniLM hybrid retrieval:

| Cases | Recall@8, SQL → hybrid | MRR, SQL → hybrid | p50/p95 ms, SQL → hybrid |
| --- | --- | --- | --- |
| Semantic (9) | 0.667 → 1.000 | 0.500 → 0.639 | 0.2/0.4 → 59.8/64.3 |
| Temporal (3) | 1.000 → 1.000 | 1.000 → 1.000 | 0.1/0.2 → 0.3/0.4 |

The 28 deterministic regression tests cover corrections, thread scope, cross-thread claim recall, extraction failures, and missing, stale, or conflicting web evidence. Mocked providers make failures reproducible. They don’t measure live routing, answer accuracy, or provider reliability.

## 6. What I’d do with another week

Expand the labeled cases and measure Recall@3 and Recall@5 at the context cutoff, especially for conflicting or corrected claims. Run dated pricing comparisons with live providers and track citation support, time to first token, and failures. Use those results to decide whether to improve ranking, extraction, or how the agent asks for clarification.
