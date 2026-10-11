export interface SessionGrantsResponse {
  session_id: string;
  grants: string[];
}

export function parseSessionGrantsResponse(value: unknown, expectedSessionId: string): string[] | null {
  if (!value || typeof value !== 'object') return null;
  const response = value as Partial<SessionGrantsResponse>;
  if (response.session_id !== expectedSessionId || !Array.isArray(response.grants)) return null;
  if (!response.grants.every((grant) => typeof grant === 'string')) return null;
  return [...response.grants];
}
