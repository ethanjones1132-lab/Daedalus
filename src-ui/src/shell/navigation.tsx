import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { resolveRoute, type RouteId } from './routes';

/*
 * Navigation state. The current route persists to localStorage under the
 * legacy key `jarvis-current-view` (validated + alias-resolved on boot).
 * `params` carry one-shot intents, e.g. { sessionId } when another surface
 * asks the Sessions page to open a specific Session.
 */

export const VIEW_STORAGE_KEY = 'jarvis-current-view';

export type RouteParams = Record<string, string | undefined>;

export interface NavigationValue {
  route: RouteId;
  params: RouteParams;
  navigate: (id: RouteId | string, params?: RouteParams) => void;
  /** Bumped on every navigate, so pages can react to repeated intents. */
  nonce: number;
}

const NavigationContext = createContext<NavigationValue | null>(null);

function readStored(): RouteId {
  try {
    return resolveRoute(localStorage.getItem(VIEW_STORAGE_KEY));
  } catch {
    return resolveRoute(null);
  }
}

export function NavigationProvider({ children, initial }: { children: ReactNode; initial?: RouteId }) {
  const [state, setState] = useState<{ route: RouteId; params: RouteParams; nonce: number }>(() => ({
    route: initial ?? readStored(),
    params: {},
    nonce: 0,
  }));

  const navigate = useCallback((id: RouteId | string, params: RouteParams = {}) => {
    const route = resolveRoute(id);
    setState((prev) => ({ route, params, nonce: prev.nonce + 1 }));
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, route);
    } catch {
      /* storage unavailable — navigation still works for this session */
    }
  }, []);

  const value = useMemo(() => ({ ...state, navigate }), [state, navigate]);
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

const FALLBACK: NavigationValue = { route: 'sessions', params: {}, nonce: 0, navigate: () => undefined };

/** Safe outside a provider (isolated view tests): navigation becomes a no-op. */
export function useNavigation(): NavigationValue {
  return useContext(NavigationContext) ?? FALLBACK;
}
