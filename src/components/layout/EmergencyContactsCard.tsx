import { memo } from "react";
import { Phone } from "lucide-react";
import { EMERGENCY_CONTACTS } from "../../utils/emergency";

interface EmergencyContactsCardProps {
  isArabic: boolean;
  compact?: boolean;
}

function EmergencyContactsCard({ isArabic, compact = false }: EmergencyContactsCardProps) {
  return (
    <div className={`bg-zinc-900/50 border border-white/5 rounded-xl p-4 shadow-[0_4px_25px_rgba(0,0,0,0.5)] text-center space-y-3 relative overflow-hidden ${compact ? "w-full" : ""}`}>
      <div className="absolute top-0 right-0 h-16 w-16 bg-red-500/5 rounded-full blur-xl"></div>
      <h4 className="font-extrabold text-sm text-slate-200 flex items-center justify-center gap-2">
        <Phone className="h-4 w-4 text-red-500" />
        {isArabic ? "أرقام النجدة الرسمية — شمال إفريقيا" : "Numéros de Secours — Afrique du Nord"}
      </h4>
      <div className={`grid gap-2 text-xs font-mono ${compact ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-2"}`}>
        {EMERGENCY_CONTACTS.map((c) => (
          <a
            key={`${c.countryFr}-${c.phone}`}
            href={`tel:${c.phone}`}
            className="p-2 bg-black/40 hover:bg-zinc-800 rounded border border-white/5 text-red-400 font-bold flex flex-col items-center"
          >
            <span className="text-[10px] text-gray-400 font-sans">
              {isArabic ? c.labelAr : c.labelFr} — {isArabic ? c.countryAr : c.countryFr}
            </span>
            <span className="text-sm mt-0.5">{c.phone}</span>
          </a>
        ))}
      </div>
      <p className="text-[9px] text-gray-500 italic">
        {isArabic ? "أرقام رسمية لكل دولة — اضغط للاتصال المباشر." : "Numéros officiels par pays — cliquez pour appeler."}
      </p>
    </div>
  );
}

export default memo(EmergencyContactsCard);
