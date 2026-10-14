/** Valid no-memory native responses for the Session-turn regression suite. */
export function nativeMemoryFixture(command: string, args: Record<string, any> = {}): unknown {
  if (command === 'append_message') return `persisted-${args.role ?? 'message'}`;
  if (command === 'goal_list' || command === 'list_agents') return [];
  if (command === 'memory_turn_history') return [];
  if (command === 'memory_prepare_turn') return { turn_id: args.request.turn_id, preparation_id: null, status: 'unavailable' };
  // Unavailable optional reads stay unavailable, without fabricating a receipt.
  if (command === 'memory_continuity_read' || command === 'memory_turn_diagnostic' || command === 'memory_capture_turn' || command === 'memory_sync_turn') return null;
  return undefined;
}
