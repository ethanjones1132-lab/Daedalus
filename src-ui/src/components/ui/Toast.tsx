import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from './index';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void;
    }

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  title?: string;
  duration?: number;
  action?: ToastAction;
}
    
interface ToastContextType {
  toast: (message: string, type?: ToastType, title?: string, duration?: number, action?: ToastAction) => void;
  success: (message: string, title?: string, duration?: number, action?: ToastAction) => void;
  error: (message: string, title?: string, duration?: number, action?: ToastAction) => void;
  warn: (message: string, title?: string, duration?: number, action?: ToastAction) => void;
  info: (message: string, title?: string, duration?: number, action?: ToastAction) => void;
  removeToast: (id: string) => void;
}

    const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

    export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, type: ToastType = 'info', title?: string, duration = 4000, action?: ToastAction) => {
      const id = crypto.randomUUID();
          setToasts((prev) => [...prev, { id, message, type, title, duration, action }]);

      if (duration > 0) {
        setTimeout(() => {
          removeToast(id);
        }, duration);
      }
    },
    [removeToast]
  );
    
  const success = useCallback(
    (message: string, title = 'Success', duration?: number, action?: ToastAction) => toast(message, 'success', title, duration, action),
    [toast]
  );

  const error = useCallback(
    (message: string, title = 'Error', duration?: number, action?: ToastAction) => toast(message, 'error', title, duration, action),
    [toast]
  );
    
  const warn = useCallback(
    (message: string, title = 'Warning', duration?: number, action?: ToastAction) => toast(message, 'warning', title, duration, action),
    [toast]
  );

  const info = useCallback(
    (message: string, title = 'Info', duration?: number, action?: ToastAction) => toast(message, 'info', title, duration, action),
    [toast]
  );
... 87 lines not shown ...