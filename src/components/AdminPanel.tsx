import { useState } from "react";
import { Lock, Unlock, Shield, Trash2, Check, X, AlertTriangle, RefreshCw, Layers, MapPin, Phone, User, Clock, Search, Download, ScrollText } from "lucide-react";
import { Report, Language } from "../types";
import AuditLog from "./admin/AuditLog";
import SafeZonesManager from "./admin/SafeZonesManager";

interface AdminPanelProps {
  reports: Report[];
  onRefresh: () => void;
  lang: Language;
}

export default function AdminPanel({ reports, onRefresh, lang }: AdminPanelProps) {
  const [password, setPassword] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return !!sessionStorage.getItem("admin_token");
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [activeSection, setActiveSection] = useState<"reports" | "audit" | "zones">("reports");
  const ITEMS_PER_PAGE = 20;

  const isArabic = lang === "ar";

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
      const data = await res.json();

      if (res.ok && data.token) {
        setIsAuthenticated(true);
        sessionStorage.setItem("admin_token", data.token);
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
    sessionStorage.removeItem("admin_token");
  };

  const getToken = () => sessionStorage.getItem("admin_token");

  const handleAuthError = (res: Response) => {
    if (res.status === 401) {
      handleLogout();
      alert(isArabic ? "انتهت صلاحية جلستك — سجّل الدخول مجدداً" : "Session expirée — veuillez vous reconnecter");
      return true;
    }
    return false;
  };

  const updateReportStatus = async (id: string, newStatus: string) => {
    setUpdatingId(id);
    const token = getToken();
    try {
      const res = await fetch(`/api/admin/reports/${id}/update-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ status: newStatus }),
      });

      if (res.ok) {
        onRefresh();
      } else if (!handleAuthError(res)) {
        alert(isArabic ? "فشل تحديث الحالة" : "Échec de la mise à jour de l'état");
      }
    } catch (err) {
      console.error(err);
    } finally {
      setUpdatingId(null);
    }
  };

  const updateReportSeverity = async (id: string, newSeverity: string) => {
    setUpdatingId(id);
    const token = getToken();
    try {
      const res = await fetch(`/api/admin/reports/${id}/update-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ severity: newSeverity }),
      });

      if (res.ok) {
        onRefresh();
      } else if (!handleAuthError(res)) {
        alert(isArabic ? "فشل تحديث درجة الخطورة" : "Échec de la mise à jour de la gravité");
      }
    } catch (err) {
      console.error(err);
    } finally {
      setUpdatingId(null);
    }
  };

  const deleteReport = async (id: string) => {
    if (!confirm(isArabic ? "هل أنت متأكد من رغبتك في حذف هذا البلاغ نهائياً؟" : "Êtes-vous sûr de vouloir supprimer définitivement ce signalement ?")) {
      return;
    }

    setUpdatingId(id);
    const token = getToken();
    try {
      const res = await fetch(`/api/admin/reports/${id}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      });

      if (res.ok) {
        onRefresh();
      } else if (!handleAuthError(res)) {
        alert(isArabic ? "فشل حذف البلاغ" : "Échec de la suppression du signalement");
      }
    } catch (err) {
      console.error(err);
    } finally {
      setUpdatingId(null);
    }
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
              : "Veuillez entrer le mot de passe administrateur pour modérer les signalements, valider les urgences ou supprimer les spams."}
          </p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div className="relative">
            <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
            <input
              type="password"
              placeholder={isArabic ? "كلمة المرور" : "Mot de passe"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full bg-black/50 border border-white/10 rounded-xl py-3 pl-11 pr-4 text-sm text-slate-200 placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-red-650 transition-all font-mono text-center"
            />
          </div>

          {error && (
            <p className="text-xs font-bold text-red-500 flex items-center gap-1.5 justify-center bg-red-500/5 py-2 rounded-lg border border-red-500/10">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-black tracking-wider uppercase shadow-lg shadow-red-600/10 transition-all flex items-center justify-center gap-2 cursor-pointer"
          >
            {loading ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <Unlock className="h-4 w-4" />
                <span>{isArabic ? "ولوج المشرف" : "S'authentifier"}</span>
              </>
            )}
          </button>
        </form>

        <p className="text-[10px] text-gray-600 font-mono">
          {isArabic ? "مستوى التشفير: AES-256 Cloud Firewall" : "Niveau de sécurité : Pare-feu AES-256"}
        </p>
      </div>
    );
  }

  // Statistics calculation for the admin summary cards
  const pendingReports = reports.filter(r => r.status === "pending");
  const verifiedReports = reports.filter(r => r.status === "verified");
  const resolvedReports = reports.filter(r => r.status === "resolved");

  const exportToCSV = () => {
    const rows = [
      ["ID", "الموقع", "الولاية", "الحالة", "الخطورة", "الوصف", "المُبلغ", "الهاتف", "الوقت"].join(","),
      ...reports.map((r) =>
        [
          r.id,
          `"${(r.locationName || "").replace(/"/g, '""')}"`,
          `"${(r.wilaya || "").replace(/"/g, '""')}"`,
          r.status,
          r.severity,
          `"${(r.description || "").replace(/"/g, '""')}"`,
          `"${(r.reporterName || "").replace(/"/g, '""')}"`,
          r.reporterPhone || "",
          r.timestamp,
        ].join(",")
      ),
    ].join("\n");

    const blob = new Blob(["\ufeff" + rows], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reports_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredReports = reports.filter((r) => {
    const matchesSearch =
      !searchQuery.trim() ||
      (r.locationName || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (r.wilaya || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (r.description || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (r.reporterName || "").toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || r.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const totalPages = Math.max(1, Math.ceil(filteredReports.length / ITEMS_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const paginatedReports = filteredReports.slice((safePage - 1) * ITEMS_PER_PAGE, safePage * ITEMS_PER_PAGE);

  return (
    <div id="admin-panel-container" className="space-y-6 w-full animate-fade-in">
      
      {/* Admin header */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 bg-zinc-900/50 border border-white/5 p-5 rounded-2xl shadow-xl">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 bg-emerald-600/10 border border-emerald-500/20 rounded-xl flex items-center justify-center text-emerald-400">
            <Shield className="h-6 w-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-black text-slate-100">
                {isArabic ? "لوحة تحكم المشرف والتدخل الميداني" : "Console d'Administration & Gestion"}
              </h2>
              <span className="bg-emerald-600 text-white text-[9px] font-bold px-2 py-0.5 rounded-full uppercase">
                {isArabic ? "أدمن نشط" : "Admin Connecté"}
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-1">
              {isArabic 
                ? "لديك الصلاحية الكاملة لتعديل بلاغات المواطنين، ترقية البلاغات، أو تصفية البلاغات المضللة."
                : "Droits de modération complets sur la base de données citoyenne."}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 self-end md:self-auto">
          <button
            onClick={onRefresh}
            className="p-2.5 bg-black/40 hover:bg-zinc-800 text-gray-400 hover:text-white rounded-xl border border-white/5 transition-colors cursor-pointer"
            title="Refresh Data"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          
          <button
            onClick={handleLogout}
            className="px-4 py-2 bg-red-650 hover:bg-red-700 text-white rounded-xl text-xs font-black transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            <Lock className="h-3.5 w-3.5" />
            <span>{isArabic ? "خروج" : "Déconnexion"}</span>
          </button>
        </div>
      </div>

      {/* Section Tabs */}
      <div className="flex items-center gap-2 flex-wrap">
        {([
          { id: "reports" as const, labelAr: "إدارة البلاغات", labelFr: "Signalements", icon: <Layers className="h-3.5 w-3.5" /> },
          { id: "audit" as const, labelAr: "سجل التدقيق", labelFr: "Journal d'audit", icon: <ScrollText className="h-3.5 w-3.5" /> },
          { id: "zones" as const, labelAr: "المراكز الآمنة", labelFr: "Centres sûrs", icon: <MapPin className="h-3.5 w-3.5" /> },
        ]).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveSection(tab.id)}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer border ${
              activeSection === tab.id
                ? "bg-red-600/15 border-red-500/30 text-red-400"
                : "bg-zinc-900/50 border-white/5 text-slate-400 hover:text-slate-200"
            }`}
          >
            {tab.icon}
            <span>{isArabic ? tab.labelAr : tab.labelFr}</span>
          </button>
        ))}
      </div>

      {activeSection === "audit" && (
        <AuditLog lang={lang} token={getToken()} onAuthError={handleAuthError} />
      )}

      {activeSection === "zones" && (
        <SafeZonesManager lang={lang} token={getToken()} onAuthError={handleAuthError} />
      )}

      {activeSection === "reports" && (
      <>
      {/* Admin Quick Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="bg-zinc-950/40 border border-white/5 p-4 rounded-xl space-y-1">
          <p className="text-[11px] text-gray-400">{isArabic ? "إجمالي البلاغات" : "Total signalements"}</p>
          <p className="text-2xl font-black text-white">{reports.length}</p>
        </div>
        <div className="bg-zinc-950/40 border border-white/5 p-4 rounded-xl space-y-1">
          <p className="text-[11px] text-amber-500 font-bold">{isArabic ? "بلاغات قيد المراجعة" : "En attente"}</p>
          <p className="text-2xl font-black text-amber-500">{pendingReports.length}</p>
        </div>
        <div className="bg-zinc-950/40 border border-white/5 p-4 rounded-xl space-y-1">
          <p className="text-[11px] text-emerald-400 font-bold">{isArabic ? "بلاغات موثقة رسمياً" : "Vérifiés"}</p>
          <p className="text-2xl font-black text-emerald-400">{verifiedReports.length}</p>
        </div>
        <div className="bg-zinc-950/40 border border-white/5 p-4 rounded-xl space-y-1">
          <p className="text-[11px] text-blue-400 font-bold">{isArabic ? "بلاغات تم إخمادها" : "Éteints / Résolus"}</p>
          <p className="text-2xl font-black text-blue-400">{resolvedReports.length}</p>
        </div>
      </div>

      {/* Search / Filter / Export Toolbar */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
            placeholder={isArabic ? "ابحث عن ولاية، موقع، وصف، أو مُبلغ..." : "Rechercher wilaya, lieu, description, rapporteur..."}
            className="w-full bg-black/50 border border-white/10 rounded-xl py-2.5 pl-10 pr-4 text-xs text-slate-200 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-red-500/40 transition-all"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="bg-black/50 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-slate-300 font-bold focus:ring-1 focus:ring-red-500/40 focus:outline-none cursor-pointer"
        >
          <option value="all">{isArabic ? "جميع الحالات" : "Tous les états"}</option>
          <option value="pending">{isArabic ? "قيد المراجعة" : "En attente"}</option>
          <option value="verified">{isArabic ? "موثق رسمي" : "Vérifié"}</option>
          <option value="resolved">{isArabic ? "تم الحل / خمد" : "Résolu"}</option>
          <option value="rejected">{isArabic ? "مرفوض" : "Rejeté"}</option>
        </select>
        <button
          onClick={exportToCSV}
          className="px-4 py-2.5 bg-emerald-600/15 hover:bg-emerald-600/25 border border-emerald-500/20 text-emerald-400 rounded-xl text-xs font-black flex items-center justify-center gap-1.5 cursor-pointer transition-all"
        >
          <Download className="h-4 w-4" />
          <span>{isArabic ? "تصدير CSV" : "Exporter CSV"}</span>
        </button>
      </div>

      {/* Moderation List */}
      <div className="bg-zinc-900/40 border border-white/5 rounded-2xl p-5 shadow-lg space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="font-extrabold text-sm text-slate-200">
            {isArabic ? "إدارة وتعديل بلاغات المواطنين" : "Gestion active des signalements"}
          </h3>
          <span className="text-[10px] text-gray-500 font-mono">
            {isArabic ? `${filteredReports.length} بلاغ (صفحة ${safePage}/${totalPages})` : `${filteredReports.length} signalements (page ${safePage}/${totalPages})`}
          </span>
        </div>

        <div className="space-y-4 max-h-[600px] overflow-y-auto pr-1">
          {paginatedReports.length === 0 ? (
            <div className="text-center py-12 text-xs text-gray-500">
              {isArabic
                ? (searchQuery || statusFilter !== "all"
                    ? "لا توجد بلاغات مطابقة لمعايير البحث."
                    : "لا توجد بلاغات مسجلة في النظام.")
                : "Aucun signalement trouvé."}
            </div>
          ) : (
            paginatedReports.map((rep) => (
              <div
                key={rep.id}
                className={`bg-black/50 p-4 rounded-xl border transition-all flex flex-col xl:flex-row gap-4 items-start xl:items-center justify-between ${
                  updatingId === rep.id ? "opacity-50 pointer-events-none" : ""
                } ${
                  rep.status === "rejected" ? "border-red-950/40 opacity-70" : "border-white/5"
                }`}
              >
                {/* Left Side: Report info */}
                <div className="flex gap-4 items-start flex-1">
                  {rep.image ? (
                    <img
                      src={rep.image}
                      className="w-20 h-16 object-cover rounded-lg border border-white/5 shrink-0 mt-1"
                      alt="Report"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="w-20 h-16 bg-black rounded-lg border border-white/5 flex items-center justify-center text-2xl shrink-0">
                      🔥
                    </div>
                  )}
                  
                  <div className="space-y-1.5 flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="font-extrabold text-sm text-white truncate">{rep.locationName}</h4>
                      <span className="bg-zinc-800 text-gray-300 text-[10px] px-2 py-0.5 rounded font-bold">
                        {rep.wilaya}
                      </span>
                      
                      {/* Status Badges */}
                      {rep.status === "pending" && (
                        <span className="bg-amber-500/10 border border-amber-500/30 text-amber-400 text-[9px] px-1.5 py-0.5 rounded font-bold uppercase">
                          {isArabic ? "قيد المراجعة" : "En attente"}
                        </span>
                      )}
                      {rep.status === "verified" && (
                        <span className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[9px] px-1.5 py-0.5 rounded font-bold uppercase animate-pulse">
                          {isArabic ? "موثق رسمي" : "Vérifié"}
                        </span>
                      )}
                      {rep.status === "resolved" && (
                        <span className="bg-blue-500/10 border border-blue-500/30 text-blue-400 text-[9px] px-1.5 py-0.5 rounded font-bold uppercase">
                          {isArabic ? "تم الحل / خمد" : "Résolu / Éteint"}
                        </span>
                      )}
                      {rep.status === "rejected" && (
                        <span className="bg-red-500/10 border border-red-500/30 text-red-400 text-[9px] px-1.5 py-0.5 rounded font-bold uppercase">
                          {isArabic ? "بلاغ مضلل / مرفوض" : "Rejeté / Spam"}
                        </span>
                      )}

                      {/* Severity Badges */}
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${
                        rep.severity === "critical" ? "bg-red-650 text-white" :
                        rep.severity === "high" ? "bg-orange-500/20 text-orange-400 border border-orange-500/30" :
                        rep.severity === "medium" ? "bg-amber-500/20 text-amber-400 border border-amber-500/30" :
                        "bg-zinc-800 text-gray-400"
                      }`}>
                        {rep.severity}
                      </span>
                    </div>

                    <p className="text-xs text-gray-300 leading-relaxed font-sans">{rep.description}</p>
                    
                    {/* Reporter Metadata */}
                    <div className="flex flex-wrap items-center gap-3 text-[10px] text-gray-500 font-mono">
                      <span className="flex items-center gap-1">
                        <User className="h-3 w-3" />
                        <span>{rep.reporterName || (isArabic ? "مواطن مجهول" : "Anonyme")} ({rep.reporterType})</span>
                      </span>
                      {rep.reporterPhone && (
                        <a href={`tel:${rep.reporterPhone}`} className="flex items-center gap-1 hover:text-red-400">
                          <Phone className="h-3 w-3" />
                          <span>{rep.reporterPhone}</span>
                        </a>
                      )}
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        <span>{new Date(rep.timestamp).toLocaleString()}</span>
                      </span>
                      <span className="bg-black/40 px-1.5 py-0.5 rounded border border-white/5">
                        ID: {rep.id}
                      </span>
                    </div>

                    {/* AI Verification Overlay if any */}
                    {rep.aiVerification && (
                      <div className="bg-purple-950/10 border border-purple-500/20 p-2.5 rounded-lg text-[11px] text-purple-300 space-y-1">
                        <span className="font-bold flex items-center gap-1 text-purple-400">
                          🤖 {isArabic ? "التحليل الذكي للذكاء الاصطناعي:" : "Analyse de Vision IA :"}
                        </span>
                        <p className="italic">{rep.aiVerification.aiComments}</p>
                        <p className="text-[10px] text-purple-400/80 font-mono">
                          {isArabic ? "درجة ثقة الذكاء الاصطناعي: " : "Indice de confiance : "}{rep.aiVerification.confidence}% | 
                          {isArabic ? " العلامات المكتشفة: " : " Signes détectés : "}{rep.aiVerification.detectedSigns.join(", ")}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Right Side: Action Control Tools */}
                <div className="flex flex-row xl:flex-col gap-2.5 w-full xl:w-auto shrink-0 border-t xl:border-t-0 border-white/5 pt-3 xl:pt-0 justify-end items-center">
                  
                  {/* Severity Adjuster */}
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-gray-500 hidden xl:inline">{isArabic ? "الخطورة:" : "Gravité:"}</span>
                    <select
                      value={rep.severity}
                      onChange={(e) => updateReportSeverity(rep.id, e.target.value)}
                      className="bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs text-slate-300 font-bold focus:ring-1 focus:ring-red-500 focus:outline-none"
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="critical">Critical</option>
                    </select>
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap">
                    {/* Verify button */}
                    {rep.status !== "verified" && (
                      <button
                        onClick={() => updateReportStatus(rep.id, "verified")}
                        className="p-1.5 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/20 text-emerald-400 rounded-lg text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-all"
                        title="Verify Report"
                      >
                        <Check className="h-3.5 w-3.5" />
                        <span>{isArabic ? "توثيق" : "Valider"}</span>
                      </button>
                    )}

                    {/* Resolve button */}
                    {rep.status !== "resolved" && (
                      <button
                        onClick={() => updateReportStatus(rep.id, "resolved")}
                        className="p-1.5 bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/20 text-blue-400 rounded-lg text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-all"
                        title="Mark as Resolved"
                      >
                        <Layers className="h-3.5 w-3.5" />
                        <span>{isArabic ? "خمدت" : "Résoudre"}</span>
                      </button>
                    )}

                    {/* Reject button */}
                    {rep.status !== "rejected" && (
                      <button
                        onClick={() => updateReportStatus(rep.id, "rejected")}
                        className="p-1.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 rounded-lg text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-all"
                        title="Reject / Mark as Spam"
                      >
                        <X className="h-3.5 w-3.5" />
                        <span>{isArabic ? "رفض" : "Rejeter"}</span>
                      </button>
                    )}

                    {/* Delete button */}
                    <button
                      onClick={() => deleteReport(rep.id)}
                      className="p-1.5 bg-zinc-900 hover:bg-red-650/25 border border-white/5 hover:border-red-500/30 text-gray-400 hover:text-red-400 rounded-lg text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-all"
                      title="Delete Report Permanently"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>{isArabic ? "حذف" : "Supprimer"}</span>
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-3 pt-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              className="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 border border-white/10 rounded-lg text-xs font-bold text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-all"
            >
              {isArabic ? "السابق" : "Précédent"}
            </button>
            <span className="text-xs text-gray-400 font-mono">{safePage} / {totalPages}</span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
              className="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 border border-white/10 rounded-lg text-xs font-bold text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-all"
            >
              {isArabic ? "التالي" : "Suivant"}
            </button>
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}
