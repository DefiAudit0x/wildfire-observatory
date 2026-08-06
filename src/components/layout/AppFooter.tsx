import { memo } from "react";

interface AppFooterProps {
  isArabic: boolean;
}

function AppFooter({ isArabic }: AppFooterProps) {
  return (
    <footer className="bg-[#050303]/40 border-t border-white/5 text-center py-6 mt-12 text-xs text-gray-500">
      <div className="max-w-7xl mx-auto px-4 space-y-1.5">
        <p>
          {isArabic
            ? "المرصد الشمال الإفريقي لحرائق الغابات والكوارث - مبادرة تضامنية لتسريع الاستجابة ومشاركة البيانات بين المواطنين."
            : "Observatoire Nord-Africain des Feux de Forêt et Catastrophes - Initiative solidaire de réponse rapide."}
        </p>
        <p className="text-[10px] text-gray-650 font-mono">
          {isArabic
            ? "مدعوم بنموذج الذكاء الاصطناعي وبوابة ناسا للأقمار الصناعية (NASA FIRMS) © 2026."
            : "Propulsé par Gemini AI et la passerelle NASA FIRMS © 2026."}
        </p>
        <p className="text-[11px] text-amber-500/80 font-semibold mt-2">
          {isArabic ? (
            <>
              الحقوق محفوظة لمبرمجي مجموعتنا <span className="font-bold text-amber-400">nova dz</span>. لو أردت الانضمام{" "}
              <a
                href="https://facebook.com/groups/1295962545580951/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-amber-300 transition-colors font-extrabold"
              >
                اضغط هنا
              </a>
            </>
          ) : (
            <>
              Tous droits réservés aux développeurs de notre groupe <span className="font-bold text-amber-400">nova dz</span>. Pour nous rejoindre,{" "}
              <a
                href="https://facebook.com/groups/1295962545580951/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-amber-300 transition-colors font-extrabold"
              >
                cliquez ici
              </a>
            </>
          )}
        </p>
      </div>
    </footer>
  );
}

export default memo(AppFooter);