import { useState, useEffect } from "react";
import { Lock, Unlock, Shield, Trash2, Check, X, AlertTriangle, RefreshCw, Layers, MapPin, Phone, User, Clock, Plus, BadgeCheck, Users, ToggleLeft, ToggleRight } from "lucide-react";
import { Report, Language, BadgeCode, VolunteerRegistration } from "../types";

interface AdminPanelProps {
  reports: Report[];
  onRefresh: () => void;
  lang: Language;
}

export default function AdminPanel({ reports, onRefresh, lang }: AdminPanelProps) {
  const [password, setPassword] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return sessionStorage.getItem("admin_authenticated") === "true";
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [adminTab, setAdminTab] = useState<"reports" | "badges" | "registrations">("reports");

  // Badge codes state
  const [badgeCodes, setBadgeCodes] = useState<BadgeCode[]>([]);
  const [newCode, setNewCode] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const [newType, setNewType] = useState<"official" | "volunteer">("volunteer");
  const [newWilaya, setNewWilaya] = useState("");

  // Registrations state
  const [registrations, setRegistrations] = useState<VolunteerRegistration[]>([]);
  const [approveCode, setApproveCode] = useState<Record<string, string>>({});

  const isArabic = lang === "ar";

  const adminPass = sessionStorage.getItem("admin_password") || password;

  const fetchBadgeCodes = async () => {
    try {
      const res = await fetch("/api/badges");
      if (res.ok) setBadgeCodes(await res.json());
    } catch (err) { console.error(err); }
  };

  const fetchRegistrations = async () => {
    try {
      const res = await fetch(`/api/volunteer/pending?password=${encodeURIComponent(adminPass)}`);
      if (res.ok) setRegistrations(await res.json());
    } catch (err) { console.error(err); }
  };

  useEffect(() => {
    if (isAuthenticated) {
      fetchBadgeCodes();
      fetchRegistrations();
    }
  }, [isAuthenticated]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/admin/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        setIsAuthenticated(true);
        sessionStorage.setItem("admin_authenticated", "true");
        sessionStorage.setItem("admin_password", password);
      } else {
        setError(isArabic ? "رمز المرور غير صحيح!" : "Mot de passe incorrect !");
      }
    } catch (err) {
      setError(isArabic ? "حدث خطأ في الاتصال بالخادم" : "Erreur de connexion au serveur");
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    setIsAuthenticated(false);
    setPassword("");
    sessionStorage.removeItem("admin_authenticated");
    sessionStorage.removeItem("admin_password");
  };

  const handleAddBadge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCode || !newOwner || !newWilaya) return;
    setUpdatingId("new");
    try {
      const res = await fetch("/api/badges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPass, code: newCode, ownerName: newOwner, type: newType, wilaya: newWilaya }),
      });
      if (res.ok) {
        setNewCode(""); setNewOwner(""); setNewWilaya("");
        fetchBadgeCodes();
      } else {
        const data = await res.json();
        alert(data.error || "Error");
      }
    } catch (err) { console.error(err); }
    finally { setUpdatingId(null); }
  };

  const handleDeleteBadge = async (code: string) => {
    if (!confirm(isArabic ? `حذف الرمز ${code}؟` : `Supprimer le code ${code} ?`)) return;
    try {
      await fetch(`/api/badges/${code}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPass }),
      });
      fetchBadgeCodes();
    } catch (err) { console.error(err); }
  };

  const handleToggleBadge = async (code: string) => {
    try {
      await fetch(`/api/badges/${code}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPass }),
      });
      fetchBadgeCodes();
    } catch (err) { console.error(err); }
  };

  const handleApproveRegistration = async (id: string, assignedCode: string) => {
    if (!assignedCode) return alert(isArabic ? "يرجى إدخال رمز اعتماد" : "Entrez un code d'accréditation");
    try {
      const res = await fetch(`/api/volunteer/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPass, status: "approved", assignedCode }),
      });
      if (res.ok) { fetchRegistrations(); fetchBadgeCodes(); }
    } catch (err) { console.error(err); }
  };

  const handleRejectRegistration = async (id: string) => {
    try {
      await fetch(`/api/volunteer/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPass, status: "rejected" }),
      });
      fetchRegistrations();
    } catch (err) { console.error(err); }
  };

  const updateReportStatus = async (id: string, newStatus: string) => {
    setUpdatingId(id);
    try {
      const res = await fetch(`/api/admin/reports/${id}/update-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPass, status: newStatus }),
      });
      if (res.ok) onRefresh();
      else alert(isArabic ? "فشل تحديث الحالة" : "Échec de la mise à jour");
    } catch (err) { console.error(err); }
    finally { setUpdatingId(null); }
  };

  const updateReportSeverity = async (id: string, newSeverity: string) => {
    setUpdatingId(id);
    try {
      const res = await fetch(`/api/admin/reports/${id}/update-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPass, severity: newSeverity }),
      });
      if (res.ok) onRefresh();
      else alert(isArabic ? "فشل تحديث درجة الخطورة" : "Échec mise à jour gravité");
    } catch (err) { console.error(err); }
    finally { setUpdatingId(null); }
  };

  const deleteReport = async (id: string) => {
    if (!confirm(isArabic ? "حذف هذا البلاغ نهائياً؟" : "Supprimer définitivement ?")) return;
    setUpdatingId(id);
    try {
      const res = await fetch(`/api/admin/reports/${id}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPass }),
      });
      if (res.ok) onRefresh();
    } catch (err) { console.error(err); }
    finally { setUpdatingId(null); }
  };

  if (!isAuthenticated) {
    return (
      <div id="admin-auth-card" className="max-w-md mx-auto my-12 bg-zinc-950/80 border border-white/5 rounded-2xl p-8 shadow-[0_10px_50px_rgba(0,0,0,0.8)] text-center space-y-6">
        <div className="mx-auto w-16 h-16 bg-red-600/10 border border-red-500/20 rounded-2xl flex items-center justify-center text-red-500">
          <Shield className="h-8 w-8 animate-pulse" />
        </div>
        <div>
          <h2 className="text-xl font-extrabold tracking-tight text-slate-100">
            {isArabic ? "لوحة تحكم المشرفين الأمنية" : "Console de Modération Sécurisée"}
          </h2>
          <p className="text-xs text-gray-400 mt-1.5 leading-normal">
            {isArabic
              ? "يرجى إدخال كلمة مرور المشرف لمراجعة بلاغات المواطنين، تعديل حالات الطوارئ، وحذف البلاغات المضللة."
              : "Veuillez entrer le mot de passe administrateur pour modérer les signalements."}
          </p>
        </div>
        <form onSubmit={handleLogin} className="space-y-4">
          <div className="relative">
            <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
            <input type="password" placeholder={isArabic ? "كلمة المرور (***REMOVED***)" : "Mot de passe (***REMOVED***)"} value={password} onChange={(e) => setPassword(e.target.value)} required
              className="w-full bg-black/50 border border-white/10 rounded-xl py-3 pl-11 pr-4 text-sm text-slate-200 placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-red-650 transition-all font-mono text-center" />
          </div>
          {error && (
            <p className="text-xs font-bold text-red-500 flex items-center gap-1.5 justify-center bg-red-500/5 py-2 rounded-lg border border-red-500/10">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </p>
          )}
          <button type="submit" disabled={loading}
            className="w-full py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-black tracking-wider uppercase shadow-lg shadow-red-600/10 transition-all flex items-center justify-center gap-2 cursor-pointer">
            {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <><Unlock className="h-4 w-4" /><span>{isArabic ? "ولوج المشرف" : "S'authentifier"}</span></>}
          </button>
        </form>
        <p className="text-[10px] text-gray-600 font-mono">{isArabic ? "مستوى التشفير: AES-256 Cloud Firewall" : "Niveau de sécurité : Pare-feu AES-256"}</p>
      </div>
    );
  }

  const pendingReports = reports.filter(r => r.status === "pending");
  const verifiedReports = reports.filter(r => r.status === "verified");
  const resolvedReports = reports.filter(r => r.status === "resolved");

  return (
    <div id="admin-panel-container" className="space-y-6 w-full animate-fade-in">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 bg-zinc-900/50 border border-white/5 p-5 rounded-2xl shadow-xl">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 bg-emerald-600/10 border border-emerald-500/20 rounded-xl flex items-center justify-center text-emerald-400">
            <Shield className="h-6 w-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-black text-slate-100">
                {isArabic ? "لوحة تحكم المشرف والتدخل الميداني" : "Console d'Administration"}
              </h2>
              <span className="bg-emerald-600 text-white text-[9px] font-bold px-2 py-0.5 rounded-full uppercase">
                {isArabic ? "أدمن نشط" : "Admin Connecté"}
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-1">
              {isArabic ? "الصلاحية الكاملة لتعديل البلاغات وإدارة رموز الاعتماد والمتطوعين" : "Droits de modération complets."}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2.5 self-end md:self-auto">
          <button onClick={() => { onRefresh(); fetchBadgeCodes(); fetchRegistrations(); }}
            className="p-2.5 bg-black/40 hover:bg-zinc-800 text-gray-400 hover:text-white rounded-xl border border-white/5 transition-colors cursor-pointer">
            <RefreshCw className="h-4 w-4" />
          </button>
          <button onClick={handleLogout}
            className="px-4 py-2 bg-red-650 hover:bg-red-700 text-white rounded-xl text-xs font-black transition-colors flex items-center gap-1.5 cursor-pointer">
            <Lock className="h-3.5 w-3.5" />
            <span>{isArabic ? "خروج" : "Déconnexion"}</span>
          </button>
        </div>
      </div>

      {/* Admin Tabs */}
      <div className="flex gap-2 border-b border-white/5 pb-2">
        {[
          { id: "reports", labelAr: "إدارة البلاغات", labelFr: "Signalements", icon: <Layers className="h-4 w-4" /> },
          { id: "badges", labelAr: "رموز الاعتماد", labelFr: "Codes d'accréditation", icon: <BadgeCheck className="h-4 w-4" /> },
          { id: "registrations", labelAr: "طلبات التسجيل", labelFr: "Inscriptions volontaires", icon: <Users className="h-4 w-4" /> },
        ].map((tab) => (
          <button key={tab.id} onClick={() => setAdminTab(tab.id as any)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
              adminTab === tab.id ? "bg-red-650 text-white" : "text-slate-400 hover:text-slate-200 hover:bg-white/5"
            }`}>
            {tab.icon}
            <span>{isArabic ? tab.labelAr : tab.labelFr}</span>
          </button>
        ))}
      </div>

      {/* TAB: REPORTS */}
      {adminTab === "reports" && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div className="bg-zinc-950/40 border border-white/5 p-4 rounded-xl space-y-1">
              <p className="text-[11px] text-gray-400">{isArabic ? "إجمالي البلاغات" : "Total signalements"}</p>
              <p className="text-2xl font-black text-white">{reports.length}</p>
            </div>
            <div className="bg-zinc-950/40 border border-white/5 p-4 rounded-xl space-y-1">
              <p className="text-[11px] text-amber-500 font-bold">{isArabic ? "قيد المراجعة" : "En attente"}</p>
              <p className="text-2xl font-black text-amber-500">{pendingReports.length}</p>
            </div>
            <div className="bg-zinc-950/40 border border-white/5 p-4 rounded-xl space-y-1">
              <p className="text-[11px] text-emerald-400 font-bold">{isArabic ? "موثقة رسمياً" : "Vérifiés"}</p>
              <p className="text-2xl font-black text-emerald-400">{verifiedReports.length}</p>
            </div>
            <div className="bg-zinc-950/40 border border-white/5 p-4 rounded-xl space-y-1">
              <p className="text-[11px] text-blue-400 font-bold">{isArabic ? "تم إخمادها" : "Résolus"}</p>
              <p className="text-2xl font-black text-blue-400">{resolvedReports.length}</p>
            </div>
          </div>

          <div className="bg-zinc-900/40 border border-white/5 rounded-2xl p-5 shadow-lg space-y-4">
            <h3 className="font-extrabold text-sm text-slate-200">
              {isArabic ? "إدارة وتعديل بلاغات المواطنين" : "Gestion active des signalements"}
            </h3>
            <div className="space-y-4 max-h-[600px] overflow-y-auto pr-1">
              {reports.length === 0 ? (
                <div className="text-center py-12 text-xs text-gray-500">
                  {isArabic ? "لا توجد بلاغات مسجلة في النظام." : "Aucun signalement trouvé."}
                </div>
              ) : reports.map((rep) => (
                <div key={rep.id}
                  className={`bg-black/50 p-4 rounded-xl border transition-all flex flex-col xl:flex-row gap-4 items-start xl:items-center justify-between ${
                    updatingId === rep.id ? "opacity-50 pointer-events-none" : ""} ${
                    rep.status === "rejected" ? "border-red-950/40 opacity-70" : "border-white/5"}`}>
                  <div className="flex gap-4 items-start flex-1">
                    {rep.image ? (
                      <img src={rep.image} className="w-20 h-16 object-cover rounded-lg border border-white/5 shrink-0 mt-1" alt="" referrerPolicy="no-referrer" />
                    ) : (
                      <div className="w-20 h-16 bg-black rounded-lg border border-white/5 flex items-center justify-center text-2xl shrink-0">🔥</div>
                    )}
                    <div className="space-y-1.5 flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="font-extrabold text-sm text-white truncate">{rep.locationName}</h4>
                        <span className="bg-zinc-800 text-gray-300 text-[10px] px-2 py-0.5 rounded font-bold">{rep.wilaya}</span>
                        {rep.status === "pending" && <span className="bg-amber-500/10 border border-amber-500/30 text-amber-400 text-[9px] px-1.5 py-0.5 rounded font-bold uppercase">{isArabic ? "قيد المراجعة" : "En attente"}</span>}
                        {rep.status === "verified" && <span className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[9px] px-1.5 py-0.5 rounded font-bold uppercase animate-pulse">{isArabic ? "موثق رسمي" : "Vérifié"}</span>}
                        {rep.status === "resolved" && <span className="bg-blue-500/10 border border-blue-500/30 text-blue-400 text-[9px] px-1.5 py-0.5 rounded font-bold uppercase">{isArabic ? "تم الحل" : "Résolu"}</span>}
                        {rep.status === "rejected" && <span className="bg-red-500/10 border border-red-500/30 text-red-400 text-[9px] px-1.5 py-0.5 rounded font-bold uppercase">{isArabic ? "مرفوض" : "Rejeté"}</span>}
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${
                          rep.severity === "critical" ? "bg-red-650 text-white" :
                          rep.severity === "high" ? "bg-orange-500/20 text-orange-400 border border-orange-500/30" :
                          rep.severity === "medium" ? "bg-amber-500/20 text-amber-400 border border-amber-500/30" : "bg-zinc-800 text-gray-400"}`}>
                          {rep.severity}
                        </span>
                      </div>
                      <p className="text-xs text-gray-300 leading-relaxed font-sans">{rep.description}</p>
                      <div className="flex flex-wrap items-center gap-3 text-[10px] text-gray-500 font-mono">
                        <span className="flex items-center gap-1"><User className="h-3 w-3" /><span>{rep.reporterName || (isArabic ? "مواطن" : "Anonyme")} ({rep.reporterType})</span></span>
                        {rep.reporterPhone && <a href={`tel:${rep.reporterPhone}`} className="flex items-center gap-1 hover:text-red-400"><Phone className="h-3 w-3" /><span>{rep.reporterPhone}</span></a>}
                        <span className="flex items-center gap-1"><Clock className="h-3 w-3" /><span>{new Date(rep.timestamp).toLocaleString()}</span></span>
                        <span className="bg-black/40 px-1.5 py-0.5 rounded border border-white/5">ID: {rep.id}</span>
                      </div>
                      {rep.aiVerification && (
                        <div className="bg-purple-950/10 border border-purple-500/20 p-2.5 rounded-lg text-[11px] text-purple-300 space-y-1">
                          <span className="font-bold flex items-center gap-1 text-purple-400">🤖 {isArabic ? "التحليل الذكي:" : "Analyse IA :"}</span>
                          <p className="italic">{rep.aiVerification.aiComments}</p>
                          <p className="text-[10px] text-purple-400/80 font-mono">{isArabic ? "ثقة: " : "Confiance : "}{rep.aiVerification.confidence}% | {rep.aiVerification.detectedSigns.join(", ")}</p>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-row xl:flex-col gap-2.5 w-full xl:w-auto shrink-0 border-t xl:border-t-0 border-white/5 pt-3 xl:pt-0 justify-end items-center">
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-gray-500 hidden xl:inline">{isArabic ? "الخطورة:" : "Gravité:"}</span>
                      <select value={rep.severity} onChange={(e) => updateReportSeverity(rep.id, e.target.value)}
                        className="bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs text-slate-300 font-bold focus:ring-1 focus:ring-red-500 focus:outline-none">
                        <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option>
                      </select>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {rep.status !== "verified" && (
                        <button onClick={() => updateReportStatus(rep.id, "verified")}
                          className="p-1.5 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/20 text-emerald-400 rounded-lg text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-all">
                          <Check className="h-3.5 w-3.5" /><span>{isArabic ? "توثيق" : "Valider"}</span>
                        </button>
                      )}
                      {rep.status !== "resolved" && (
                        <button onClick={() => updateReportStatus(rep.id, "resolved")}
                          className="p-1.5 bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/20 text-blue-400 rounded-lg text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-all">
                          <Layers className="h-3.5 w-3.5" /><span>{isArabic ? "خمدت" : "Résoudre"}</span>
                        </button>
                      )}
                      {rep.status !== "rejected" && (
                        <button onClick={() => updateReportStatus(rep.id, "rejected")}
                          className="p-1.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 rounded-lg text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-all">
                          <X className="h-3.5 w-3.5" /><span>{isArabic ? "رفض" : "Rejeter"}</span>
                        </button>
                      )}
                      <button onClick={() => deleteReport(rep.id)}
                        className="p-1.5 bg-zinc-900 hover:bg-red-650/25 border border-white/5 hover:border-red-500/30 text-gray-400 hover:text-red-400 rounded-lg text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-all">
                        <Trash2 className="h-3.5 w-3.5" /><span>{isArabic ? "حذف" : "Suppr."}</span>
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* TAB: BADGE CODES */}
      {adminTab === "badges" && (
        <div className="bg-zinc-900/40 border border-white/5 rounded-2xl p-5 shadow-lg space-y-6">
          <h3 className="font-extrabold text-sm text-slate-200 flex items-center gap-2">
            <BadgeCheck className="h-5 w-5 text-emerald-400" />
            {isArabic ? "إدارة رموز الاعتماد الميداني" : "Gestion des codes d'accréditation"}
          </h3>

          {/* Add new badge */}
          <form onSubmit={handleAddBadge} className="bg-black/50 border border-white/5 rounded-xl p-4 space-y-3">
            <h4 className="text-xs font-bold text-slate-300">{isArabic ? "إضافة رمز اعتماد جديد" : "Ajouter un nouveau code"}</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <input value={newCode} onChange={e => setNewCode(e.target.value)} placeholder={isArabic ? "الرمز (مثال: 555)" : "Code (ex: 555)"} required
                className="bg-black/50 border border-white/5 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-red-500/40" />
              <input value={newOwner} onChange={e => setNewOwner(e.target.value)} placeholder={isArabic ? "الاسم الكامل" : "Nom complet"} required
                className="bg-black/50 border border-white/5 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-red-500/40" />
              <select value={newType} onChange={e => setNewType(e.target.value as any)}
                className="bg-black/50 border border-white/5 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-red-500/40">
                <option value="volunteer">{isArabic ? "متطوع" : "Bénévole"}</option>
                <option value="official">{isArabic ? "جهة رسمية" : "Officiel"}</option>
              </select>
              <input value={newWilaya} onChange={e => setNewWilaya(e.target.value)} placeholder={isArabic ? "الولاية" : "Wilaya"} required
                className="bg-black/50 border border-white/5 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-red-500/40" />
            </div>
            <button type="submit" disabled={updatingId === "new"}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition-colors flex items-center gap-1.5 cursor-pointer">
              <Plus className="h-3.5 w-3.5" />
              <span>{isArabic ? "إضافة الرمز" : "Ajouter le code"}</span>
            </button>
          </form>

          {/* Badge codes list */}
          <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
            {badgeCodes.length === 0 ? (
              <p className="text-center py-8 text-xs text-gray-500">{isArabic ? "لا توجد رموز اعتماد" : "Aucun code d'accréditation"}</p>
            ) : badgeCodes.map((badge) => (
              <div key={badge.code} className={`bg-black/50 border rounded-xl p-3 flex flex-col md:flex-row gap-3 items-start md:items-center justify-between ${badge.isActive ? "border-white/5" : "border-red-950/30 opacity-60"}`}>
                <div className="flex items-center gap-3">
                  <div className={`h-10 w-10 rounded-lg flex items-center justify-center font-black text-sm ${badge.type === "official" ? "bg-amber-500/10 text-amber-400 border border-amber-500/30" : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"}`}>
                    {badge.code}
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-sm text-slate-200">{badge.ownerName}</span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${badge.type === "official" ? "bg-amber-500/10 text-amber-400" : "bg-emerald-500/10 text-emerald-400"}`}>
                        {badge.type === "official" ? (isArabic ? "رسمي" : "Officiel") : (isArabic ? "متطوع" : "Bénévole")}
                      </span>
                    </div>
                    <p className="text-[10px] text-gray-400 font-mono">{badge.wilaya} {badge.phone && `| ${badge.phone}`}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 self-end md:self-auto">
                  <button onClick={() => handleToggleBadge(badge.code)}
                    className={`p-1.5 rounded-lg text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-all ${badge.isActive ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-gray-500/10 text-gray-400 border border-gray-500/20"}`}
                    title={badge.isActive ? (isArabic ? "تعطيل" : "Désactiver") : (isArabic ? "تفعيل" : "Activer")}>
                    {badge.isActive ? <ToggleRight className="h-3.5 w-3.5" /> : <ToggleLeft className="h-3.5 w-3.5" />}
                  </button>
                  <button onClick={() => handleDeleteBadge(badge.code)}
                    className="p-1.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 rounded-lg cursor-pointer transition-all">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB: REGISTRATIONS */}
      {adminTab === "registrations" && (
        <div className="bg-zinc-900/40 border border-white/5 rounded-2xl p-5 shadow-lg space-y-6">
          <h3 className="font-extrabold text-sm text-slate-200 flex items-center gap-2">
            <Users className="h-5 w-5 text-amber-400" />
            {isArabic ? "طلبات تسجيل المتطوعين الجدد" : "Demandes d'inscription de volontaires"}
          </h3>

          <div className="space-y-3 max-h-[600px] overflow-y-auto pr-1">
            {registrations.length === 0 ? (
              <div className="text-center py-12 text-xs text-gray-500">
                {isArabic ? "لا توجد طلبات تسجيل معلقة" : "Aucune demande d'inscription en attente"}
              </div>
            ) : registrations.filter(r => r.status === "pending").length === 0 ? (
              <div className="text-center py-8 text-xs text-gray-500">
                {isArabic ? "جميع الطلبات تمت معالجتها" : "Toutes les demandes ont été traitées"}
              </div>
            ) : registrations.filter(r => r.status === "pending").map((reg) => (
              <div key={reg.id} className="bg-black/50 border border-white/5 rounded-xl p-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 bg-amber-500/10 border border-amber-500/20 rounded-lg flex items-center justify-center text-amber-400 font-bold text-sm">
                      {reg.fullName.charAt(0)}
                    </div>
                    <div>
                      <h4 className="font-bold text-sm text-slate-200">{reg.fullName}</h4>
                      <p className="text-[10px] text-gray-400">{reg.wilaya} | {reg.phone} {reg.email && `| ${reg.email}`}</p>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold mt-1 inline-block ${reg.type === "official" ? "bg-amber-500/10 text-amber-400" : "bg-emerald-500/10 text-emerald-400"}`}>
                        {reg.type === "official" ? (isArabic ? "رسمي" : "Officiel") : (isArabic ? "متطوع" : "Bénévole")}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <input
                    value={approveCode[reg.id] || ""}
                    onChange={e => setApproveCode(prev => ({ ...prev, [reg.id]: e.target.value }))}
                    placeholder={isArabic ? "رمز الاعتماد الممنوح" : "Code d'accréditation à attribuer"}
                    className="flex-1 bg-black/60 border border-white/5 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
                  />
                  <div className="flex gap-2">
                    <button onClick={() => handleApproveRegistration(reg.id, approveCode[reg.id] || "")}
                      className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-all">
                      <Check className="h-3.5 w-3.5" />
                      <span>{isArabic ? "قبول" : "Approuver"}</span>
                    </button>
                    <button onClick={() => handleRejectRegistration(reg.id)}
                      className="px-3 py-2 bg-red-600/20 hover:bg-red-600/40 border border-red-500/30 text-red-400 rounded-lg text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-all">
                      <X className="h-3.5 w-3.5" />
                      <span>{isArabic ? "رفض" : "Refuser"}</span>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* All registrations history */}
          {registrations.length > 0 && (
            <div className="border-t border-white/5 pt-4">
              <h4 className="text-xs font-bold text-slate-400 mb-3">
                {isArabic ? "جميع الطلبات (سجل)" : "Toutes les demandes (historique)"}
              </h4>
              <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                {registrations.map((reg) => (
                  <div key={reg.id} className="bg-black/30 border border-white/5 rounded-lg p-2.5 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-xs text-slate-300">{reg.fullName}</span>
                      <span className="text-[9px] text-gray-500">| {reg.wilaya}</span>
                    </div>
                    <span className={`text-[9px] px-2 py-0.5 rounded font-bold uppercase ${
                      reg.status === "approved" ? "bg-emerald-500/10 text-emerald-400" :
                      reg.status === "rejected" ? "bg-red-500/10 text-red-400" : "bg-amber-500/10 text-amber-400"
                    }`}>
                      {reg.status} {reg.assignedCode && `(${reg.assignedCode})`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
