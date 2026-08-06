import { memo } from "react";
import { AlertTriangle } from "lucide-react";

interface SosFabProps {
  isArabic: boolean;
  onTrigger: () => void;
}

function SosFab({ isArabic, onTrigger }: SosFabProps) {
  return (
    <button
      onClick={onTrigger}
      className="fixed bottom-6 right-6 z-[1500] w-16 h-16 bg-gradient-to-br from-red-600 to-red-700 hover:from-red-500 hover:to-red-600 text-white rounded-full shadow-[0_8px_32px_rgba(220,38,38,0.5)] flex items-center justify-center transition-all duration-300 hover:scale-110 active:scale-95 border border-red-400/30 group"
    >
      <div className="relative flex items-center justify-center">
        <AlertTriangle className="h-7 w-7 animate-pulse group-hover:animate-none" />
        <span className="absolute -top-1 -right-1 w-3 h-3 bg-white rounded-full animate-ping" />
      </div>
      <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[9px] font-black text-red-400 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
        {isArabic ? "أنا محاصر (SOS)" : "Je suis bloqué (SOS)"}
      </span>
    </button>
  );
}

export default memo(SosFab);