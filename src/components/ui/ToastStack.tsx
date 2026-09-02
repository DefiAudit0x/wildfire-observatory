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
  if (toasts.length === 0) return null;
  // z-[3000]: toasts report the outcome of user actions (report sent, SOS
  // dispatched). They must stay clickable/visible above EVERYTHING —
  // previously z-[110] put them UNDER the SOS FAB (z-1500) and the SOS
  // modal (z-2000), so action feedback vanished exactly when it mattered
  // (field-reported overlap bug). Centered with left-1/2 -translate-x-1/2:
  // direction-neutral in RTL.
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[3000] flex flex-col items-center gap-2 w-full max-w-sm px-4">
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