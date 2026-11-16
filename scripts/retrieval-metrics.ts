export type RetrievalMetrics = {
  hitAt8: number;
  recallAt8: number;
  mrr: number;
};

export function scoreRetrieval(returnedIds: string[], relevantIds: string[]): RetrievalMetrics {
  const relevant = new Set(relevantIds);
  const firstRelevantRank = returnedIds.findIndex((id) => relevant.has(id));
  const hits = new Set(returnedIds.filter((id) => relevant.has(id))).size;

  return {
    hitAt8: firstRelevantRank >= 0 ? 1 : 0,
    recallAt8: relevantIds.length ? hits / relevantIds.length : 0,
    mrr: firstRelevantRank >= 0 ? 1 / (firstRelevantRank + 1) : 0,
  };
}
