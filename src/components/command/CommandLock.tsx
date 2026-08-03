import { useState } from "react";
import { Crown, Eye } from "lucide-react";
import { Language } from "../../types";

interface CommandLockProps {
  lang: Language;
  onUnlocked: (password: string) => void;
}

export default function CommandLock({ lang, onUnlocked }: CommandLockProps) {
  const isArabic = lang === "ar";
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [validating, setValidating] = useState(false);

  const handleUnlock = async () => {
    setValidating(true);
    setError("");
    try {
      const res = await fetch("/api/auth/central-command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (data.valid) {
        onUnlocked(password);
      } else {
        setError(isArabic ? "كلمة السر غير صحيحة" : "Mot de passe incorrect");
      }
    } catch {
      setError(isArabic ? "فشل الاتصال بالخادم" : "Erreur de connexion au serveur");
    } finally {
      setValidating(false);
    }
  };

  return (
    <div className="col-span-12 max-w-md mx-auto mt-12">
      <div className="bg-zinc-900/70 border border-amber-500/20 rounded-2xl p-8 shadow-[0_8px_40px_rgba(0,0,0,0.6)] text-center space-y-6">
        <div className="mx-auto w-16 h-16 bg-gradient-to-br from-amber-600 to-yellow-500 rounded-2xl flex items-center justify-center shadow-[0_0_30px_rgba(251,191,36,0.2)]">
          <Crown className="h-8 w-8 text-white" />
        </div>
        <div>
          <h2 className="text-xl font-black text-amber-400">
            {isArabic ? "القيادة المركزية" : "Commandement Central"}
          </h2>
          <p className="text-xs text-gray-400 mt-2">
            {isArabic
              ? "لوحة تحكم شاملة — يُسمح بالدخول فقط للمسؤولين المفوّضين"
              : "Tableau de bord central — Accès réservé aux responsables autorisés"}
          </p>
        </div>
        <div className="space-y-3">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleUnlock()}
            placeholder={isArabic ? "كلمة السر (superadmin123)" : "Mot de passe (superadmin123)"}
            className="w-full px-4 py-3 bg-black/60 border border-amber-500/30 rounded-xl text-sm text-center text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-amber-500 transition-all"
            autoFocus
          />
          {error && <p className="text-red-400 text-xs font-bold">{error}</p>}
          <button
            onClick={handleUnlock}
            disabled={validating}
            className="w-full px-6 py-3 bg-gradient-to-r from-amber-600 to-yellow-600 hover:from-amber-500 hover:to-yellow-500 disabled:opacity-50 text-black font-black rounded-xl text-sm transition-all cursor-pointer flex items-center justify-center gap-2"
          >
            <Eye className="h-4 w-4" />
            {validating
              ? (isArabic ? "جارٍ التحقق..." : "Vérification...")
              : (isArabic ? "الدخول إلى القيادة المركزية" : "Accéder au Commandement")
            }
          </button>
        </div>
      </div>
    </div>
  );
}
