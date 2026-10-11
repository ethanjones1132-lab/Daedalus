// List snapshots cannot replace local in-flight/failed decisions or resurrect
// ids whose native decision has resolved during this view's lifetime.
export function reconcileApprovalRows<T extends { id: string }>(
  incoming: readonly T[],
  retained: readonly T[],
  settled: ReadonlySet<string>,
): T[] {
  const rows = new Map(incoming.map((row) => [row.id, row]));
  for (const row of retained) rows.set(row.id, row);
  for (const id of settled) rows.delete(id);
  return [...rows.values()];
}
