import { CheckCircle2, AlertTriangle, Info } from "lucide-react";

export type ToastType = "success" | "error" | "warning";

export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastStackProps {
  toasts: ToastItem[];
}

const ICONS: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
  error: <AlertTriangle className="h-4 w-4 text-red-400" />,
  warning: <Info className="h-4 w-4 text-amber-400" />,
};

const STYLES: Record<ToastType, string> = {
  success: "border-emerald-500/25 bg-emerald-950/80",
  error: "border-red-500/25 bg-red-950/80",
  warning: "border-amber-500/25 bg-amber-950/80",
};

export default function ToastStack({ toasts }: ToastStackProps) {
  // Fix 30b (CodeRabbit Major, review 6029588769): the live region must
  // STAY MOUNTED when the list is empty. The old `if (toasts.length === 0)
  // return null;` meant every toast arrived in the same commit as the
  // region itself, and screen readers can miss content that appears
  // together with its live region (W3C ARIA22). Toasts auto-dismiss in
  // 4 s and the list is empty most of the time, so the "first toast after
  // an empty interval" is essentially every toast. The empty container
  // renders nothing visible (no children, zero height).
  // z-[3000]: toasts report the outcome of user actions (report sent, SOS
  // dispatched). They must stay clickable/visible above EVERYTHING —
  // previously z-[110] put them UNDER the SOS FAB (z-1500) and the SOS
  // modal (z-2000), so action feedback vanished exactly when it mattered
  // (field-reported overlap bug). Centered with left-1/2 -translate-x-1/2:
  // direction-neutral in RTL.
  // Fix 30 (TST-1): toasts are the only feedback for several actions
  // (report sent, confirmation failed) — the container is a polite live
  // region so screen readers announce them. No focus change: yanking
  // focus to a transient, auto-dismissing element would pull keyboard
  // users out of the form they just submitted.
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[3000] flex flex-col items-center gap-2 w-full max-w-sm px-4"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`w-full flex items-center gap-2.5 px-4 py-3 rounded-xl border shadow-lg backdrop-blur animate-fade-in ${STYLES[t.type]}`}
        >
          {ICONS[t.type]}
          <p className="text-xs font-bold text-slate-100 leading-snug">{t.message}</p>
        </div>
      ))}
    </div>
  );
}