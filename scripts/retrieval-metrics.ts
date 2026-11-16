export type RetrievalMetrics = {
  hitAt8: number;
  recallAt3: number;
  recallAt5: number;
  recallAt8: number;
  mrr: number;
};

export function scoreRetrieval(returnedIds: string[], relevantIds: string[]): RetrievalMetrics {
  const relevant = new Set(relevantIds);
  const firstRelevantRank = returnedIds.findIndex((id) => relevant.has(id));
  const recallAt = (k: number) => relevantIds.length
    ? new Set(returnedIds.slice(0, k).filter((id) => relevant.has(id))).size / relevantIds.length
    : 0;

  return {
    hitAt8: firstRelevantRank >= 0 ? 1 : 0,
    recallAt3: recallAt(3),
    recallAt5: recallAt(5),
    recallAt8: recallAt(8),
    mrr: firstRelevantRank >= 0 ? 1 / (firstRelevantRank + 1) : 0,
  };
}
