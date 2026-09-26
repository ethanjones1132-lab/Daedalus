// An Agent card is a Native record, and the operator reads it as a routing
// control. `agents.enabled` and `agents.model` are columns on the SQLite
// `agents` row (`src-tauri/src/commands/agents.rs:22,74,288,328-340`) and
// nothing else in the Native surface resolves either one: `set_agent_enabled`
// is the one writer of `enabled`, `set_agent_identity` the one writer of
// `model`, and no other command reads the table for a turn.
//
// A turn is routed somewhere else entirely. `AgentPool` picks from
// `cfg.orchestrator.agents` — `OrchestratorAgent` entries with their own
// `model_id`, `enabled` and `default_for` stage pins
// (`server-jarvis/src/orchestration/agent-pool.ts:27-33,453-455,560-573`) — and
// that pool is served at `GET /agents/pool` (`server-jarvis/src/index.ts:5327`)
// with its coverage and live model catalog. The card next to a `StatusDot` and
// an Enable/Disable switch therefore says "this is the agent, this is the
// model, this is whether it runs", and an operator who disables a slow card has
// every reason to believe the next turn stopped routing through it. It did not.
//
// This module is where that scope is decided, so the sentence on the surface,
// the basis on the model label, and the basis on the enable switch cannot
// disagree with each other, and so a future caller cannot render one of these
// fields without the sentence that scopes it.
//
// The honest answer for this surface is the scoped one: the record write is
// real, it is confirmed by a readback, and it is reported as a record write.
// Reading the pool to say which models actually route is the capability the
// Agent pool panel row carries, and a card must not borrow its authority by
// implication before that read exists.

// Printed once, above the cards, in the surface's own voice. Both stores are
// named, because "enabled" and "model" on their own are the two words that read
// as routing.
export const AGENT_RECORD_SCOPE =
  "Enabled and the model on an Agent card are stored on that Agent record. Turn routing reads the orchestrator's Agent pool in Daedalus' configuration instead, so neither of them changes which model a turn uses.";

// The basis carried by the model label and by the enable switch. One string, so
// the two record fields on one card cannot drift into two different claims.
export const AGENT_RECORD_FIELD_BASIS =
  "A field on this Agent record. Turn routing reads the orchestrator's Agent pool in Daedalus' configuration, not this field.";

// Printed in place of a label the record does not carry. A blank pill between a
// name and an enable switch reads as a model with no name, which is a routing
// claim this surface cannot back.
export const NO_MODEL_LABEL = 'No model label';

export type AgentModelLabel =
  | {
      kind: 'labelled';
      /** The record's own text, untrimmed: what the operator typed is what it stored. */
      label: string;
      basis: string;
    }
  | {
      kind: 'unlabelled';
      label: string;
      basis: string;
    };

/**
 * Decode an `agents.model` cell into the label a card may print.
 *
 * The cell is read as `unknown` on purpose. A record written by an older build,
 * a half-written row, or a drifted payload arrives exactly as Native serialised
 * it, and a blank between a name and a routing-shaped switch is the one place
 * that would read as a model this surface never received. Whitespace is not a
 * label: it is what a trimmed-and-rejected write leaves behind.
 */
export function decodeAgentModelLabel(value: unknown): AgentModelLabel {
  if (typeof value !== 'string' || value.trim() === '') {
    return { kind: 'unlabelled', label: NO_MODEL_LABEL, basis: AGENT_RECORD_FIELD_BASIS };
  }
  return { kind: 'labelled', label: value, basis: AGENT_RECORD_FIELD_BASIS };
}
