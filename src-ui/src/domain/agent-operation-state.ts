export interface Agent {
  id: string;
  name: string;
  description: string;
  model: string;
  backend: string;
  system_prompt: string;
  enabled: boolean;
  config: string | null;
  created_at: string;
  updated_at: string;
}

export type AgentOperationAction = 'create' | 'edit' | 'enable' | 'disable' | 'delete';
export type AgentOperationPhase = 'writing' | 'write-failed' | 'reconciling' | 'read-failed';

export interface AgentExpectation {
  name: string;
  description: string;
  model: string;
  system_prompt: string;
  enabled: boolean;
}

export interface AgentOperation {
  id: string;
  row: Agent | null;
  action: AgentOperationAction;
  phase: AgentOperationPhase;
  after: number;
  expected: AgentExpectation;
}

export interface AgentOperationResult {
  rows: Agent[];
  operations: Record<string, AgentOperation>;
  confirmed: string[];
}

function sameText(left: string, right: string): boolean {
  return left.trim() === right.trim();
}

function confirms(operation: AgentOperation, observed: Agent | undefined): boolean {
  if (operation.action === 'delete') return observed === undefined;
  if (!observed) return false;
  if (operation.action === 'enable' || operation.action === 'disable') {
    return observed.enabled === operation.expected.enabled;
  }
  return observed.enabled === operation.expected.enabled
    && sameText(observed.name, operation.expected.name)
    && sameText(observed.description, operation.expected.description)
    && sameText(observed.model, operation.expected.model)
    && sameText(observed.system_prompt, operation.expected.system_prompt);
}

export function agentOperationLocked(operation: AgentOperation | undefined): boolean {
  return operation !== undefined && operation.phase !== 'write-failed';
}

export function reconcileAgents(
  snapshot: Agent[],
  operations: Record<string, AgentOperation>,
  request: number,
): AgentOperationResult {
  const rows = [...snapshot];
  const next = { ...operations };
  const confirmed: string[] = [];

  for (const [id, operation] of Object.entries(operations)) {
    const observed = snapshot.find((row) => row.id === id);
    const canReconcile = operation.phase !== 'writing' && request > operation.after;

    if (canReconcile) {
      if (operation.phase === 'write-failed') {
        delete next[id];
        continue;
      }
      if (confirms(operation, observed)) {
        delete next[id];
        confirmed.push(id);
        continue;
      }
      next[id] = { ...operation, phase: 'read-failed' };
    }

    if (operation.row) {
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) rows.push(operation.row);
      else rows[index] = operation.row;
    } else if (operation.action === 'create' && observed) {
      const index = rows.findIndex((row) => row.id === id);
      if (index >= 0) rows.splice(index, 1);
    }
  }

  return { rows, operations: next, confirmed };
}
