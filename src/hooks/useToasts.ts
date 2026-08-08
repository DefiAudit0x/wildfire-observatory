import { useCallback, useRef, useState } from "react";
import { ToastItem, ToastType } from "../components/ui/ToastStack";

export default function useToasts(autoDismissMs = 4000) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    if (timers.current[id]) {
      clearTimeout(timers.current[id]);
      delete timers.current[id];
    }
  }, []);

  const push = useCallback(
    (message: string, type: ToastType = "success") => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToasts((prev) => [...prev.slice(-2), { id, message, type }]);
      timers.current[id] = setTimeout(() => dismiss(id), autoDismissMs);
      return id;
    },
    [autoDismissMs, dismiss]
  );

  return { toasts, push, dismiss };
}