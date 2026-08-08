import { AlertTriangle, Check, X } from "lucide-react";
import { Language } from "../../types";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  lang: Language;
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = true,
  onConfirm,
  onCancel,
  lang,
}: ConfirmDialogProps) {
  if (!open) return null;
  const isArabic = lang === "ar";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-zinc-950 border border-white/10 rounded-2xl p-6 shadow-[0_10px_60px_rgba(0,0,0,0.9)] w-full max-w-sm space-y-4 animate-fade-in">
        <div className="flex items-start gap-3">
          <div className={`h-10 w-10 shrink-0 rounded-xl flex items-center justify-center ${
            danger ? "bg-red-600/10 border border-red-500/20 text-red-500" : "bg-amber-600/10 border border-amber-500/20 text-amber-500"
          }`}>
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="space-y-1 min-w-0">
            <h3 className="font-extrabold text-sm text-slate-100">{title}</h3>
            <p className="text-xs text-gray-400 leading-relaxed">{message}</p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2.5 pt-1">
          <button
            onClick={onCancel}
            className="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 border border-white/10 rounded-xl text-xs font-bold text-slate-300 flex items-center gap-1.5 cursor-pointer transition-colors"
          >
            <X className="h-3.5 w-3.5" />
            {cancelLabel || (isArabic ? "إلغاء" : "Annuler")}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 rounded-xl text-xs font-black flex items-center gap-1.5 cursor-pointer transition-colors ${
              danger
                ? "bg-red-650 hover:bg-red-700 text-white"
                : "bg-emerald-600/15 hover:bg-emerald-600/25 border border-emerald-500/20 text-emerald-400"
            }`}
          >
            <Check className="h-3.5 w-3.5" />
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}