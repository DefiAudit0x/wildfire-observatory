import { useState, useEffect } from "react";
import { Lock, Unlock, Shield, Trash2, Check, X, AlertTriangle, RefreshCw, Layers, MapPin, Phone, User, Clock, Plus, BadgeCheck, Users, ToggleLeft, ToggleRight, Radio, Archive, Eye, Search, Filter, FileText, CheckCircle2, RotateCcw } from "lucide-react";
import { Report, Language, BadgeCode, VolunteerRegistration, TrappedSOS } from "../types";

interface AdminPanelProps {
  reports: Report[];
  sosCalls?: TrappedSOS[];
  onRefresh: () => void;
  lang: Language;
}

export default function AdminPanel({ reports, sosCalls = [], onRefresh, lang }: AdminPanelProps) {
  const [password, setPassword] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return sessionStorage.getItem("admin_authenticated") === "true";
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [adminTab, setAdminTab] = useState<"reports" | "archive" | "sos" | "badges" | "registrations">("reports");

  // State for closing / resolving report modal
  const [resolveModalReport, setResolveModalReport] = useState<Report | null>(null);
  const [resolveTeam, setResolveTeam] = useState<string>("unit_1");
  const [customResolveTeam, setCustomResolveTeam] = useState<string>("");
  const [resolveOutcome, setResolveOutcome] = useState<string>("extinguished");
  const [resolveNotes, setResolveNotes] = useState<string>("");

  // State for Archive Table filtering & details inspection
  const [archiveSearch, setArchiveSearch] = useState<string>("");
  const [archiveWilayaFilter, setArchiveWilayaFilter] = useState<string>("");
  const [archiveOutcomeFilter, setArchiveOutcomeFilter] = useState<string>("");
  const [selectedDetailReport, setSelectedDetailReport] = useState<Report | null>(null);

  // Badge codes state
  const [badgeCodes, setBadgeCodes] = useState<BadgeCode[]>([]);
  const [newCode, setNewCode] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const [newType, setNewType] = useState<"official" | "volunteer">("volunteer");
  const [newWilaya, setNewWilaya] = useState("");
  const [newPhone, setNewPhone] = useState("");

  // Registrations state
  const [registrations, setRegistrations] = useState<VolunteerRegistration[]>([]);
  const [approveCode, setApproveCode] = useState<Record<string, string>>({});

  const isArabic = lang === "ar";

  const [dispatchingSosId, setDispatchingSosId] = useState<string | null>(null);
  const [dispatchType, setDispatchType] = useState<'protection_civile' | 'volunteers'>('protection_civile');
  const [selectedTeam, setSelectedTeam] = useState('');
  const [dispatchNotes, setDispatchNotes] = useState('');

  const handleDispatchSubmit = async (sosId: string) => {
    if (!selectedTeam) return;
    setLoading(true);

    let teamNameAr = "";
    let teamNameFr = "";

    if (dispatchType === 'protection_civile') {
      if (selectedTeam === 'unit_1') {
        teamNameAr = "وحدة التدخل السريع - الحماية المدنية 1";
        teamNameFr = "Unité d'Intervention Rapide - Protection Civile 1";
      } else if (selectedTeam === 'unit_2') {
        teamNameAr = "وحدة الدعم والإسناد - الحماية المدنية بجاية";
        teamNameFr = "Unité de Soutien - Protection Civile Béjaïa";
      } else if (selectedTeam === 'unit_3') {
        teamNameAr = "وحدة الإطفاء والإنقاذ الجبلية";
        teamNameFr = "Unité Mobile de Lutte Contre les Feux de Forêt";
      } else {
        teamNameAr = selectedTeam;
        teamNameFr = selectedTeam;
      }
    } else {
      if (selectedTeam === 'vol_1') {
        teamNameAr = "مجموعة الهلال الأحمر الجزائري - متطوعي الإغاثة";
        teamNameFr = "Groupe Croissant Rouge Algérien - Secouristes";
      } else if (selectedTeam === 'vol_2') {
        teamNameAr = "رابطة المتطوعين والشباب المحلي للإغاثة";
        teamNameFr = "Association des Jeunes Volontaires Locaux";
      } else if (selectedTeam === 'vol_3') {
        teamNameAr = "فرقة الدراجات النارية الجبلية للمتطوعين";
        teamNameFr = "Brigade Moto Tout-Terrain des Volontaires";
      } else {
        teamNameAr = selectedTeam;
        teamNameFr = selectedTeam;
      }
    }

    try {
      const res = await fetch(`/api/sos/${sosId}/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: dispatchType,
          teamNameAr,
          teamNameFr,
          notes: dispatchNotes
        })
      });

      if (res.ok) {
        setDispatchingSosId(null);
        setSelectedTeam('');
        setDispatchNotes('');
        onRefresh();
      }
    } catch (err) {
      console.error("Dispatch request failed:", err);
    } finally {
      setLoading(false);
    }
  };

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
        body: JSON.stringify({ password: adminPass, code: newCode, ownerName: newOwner, type: newType, wilaya: newWilaya, phone: newPhone || undefined }),
      });
      if (res.ok) {
        setNewCode(""); setNewOwner(""); setNewWilaya(""); setNewPhone("");
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

  const updateReportStatus = async (
    id: string, 
    newStatus: string, 
    extraDetails?: {
      handlingTeamAr?: string;
      handlingTeamFr?: string;
      resolutionNotes?: string;
      resolvedOutcome?: string;
    }
  ) => {
    setUpdatingId(id);
    try {
      const res = await fetch(`/api/admin/reports/${id}/update-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          password: adminPass, 
          status: newStatus,
          ...extraDetails
        }),
      });
      if (res.ok) onRefresh();
      else alert(isArabic ? "فشل تحديث الحالة" : "Échec de la mise à jour");
    } catch (err) { console.error(err); }
    finally { setUpdatingId(null); }
  };

  const handleResolveSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resolveModalReport) return;

    let teamNameAr = "";
    let teamNameFr = "";

    if (resolveTeam === "unit_1") {
      teamNameAr = "وحدة التدخل السريع - الحماية المدنية 1";
      teamNameFr = "Unité d'Intervention Rapide - Protection Civile 1";
    } else if (resolveTeam === "unit_2") {
      teamNameAr = "وحدة الدعم والإسناد - الحماية المدنية بجاية";
      teamNameFr = "Unité de Soutien - Protection Civile Béjaïa";
    } else if (resolveTeam === "unit_3") {
      teamNameAr = "وحدة الإطفاء والإنقاذ الجبلية";
      teamNameFr = "Unité Mobile de Lutte Contre les Feux de Forêt";
    } else if (resolveTeam === "vol_1") {
      teamNameAr = "مجموعة الهلال الأحمر الجزائري - متطوعي الإغاثة";
      teamNameFr = "Groupe Croissant Rouge Algérien - Secouristes";
    } else if (resolveTeam === "vol_2") {
      teamNameAr = "رابطة المتطوعين والشباب المحلي للإغاثة";
      teamNameFr = "Association des Jeunes Volontaires Locaux";
    } else if (resolveTeam === "vol_3") {
      teamNameAr = "فرقة الدراجات النارية الجبلية للمتطوعين";
      teamNameFr = "Brigade Moto Tout-Terrain des Volontaires";
    } else {
      teamNameAr = customResolveTeam.trim() || "فرقة حماية مدنية / متطوعين";
      teamNameFr = customResolveTeam.trim() || "Brigade de Secours";
    }

    await updateReportStatus(resolveModalReport.id, "resolved", {
      handlingTeamAr: teamNameAr,
      handlingTeamFr: teamNameFr,
      resolutionNotes: resolveNotes,
      resolvedOutcome: resolveOutcome,
    });

    setResolveModalReport(null);
    setCustomResolveTeam("");
    setResolveNotes("");
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
            <input type="password" placeholder={isArabic ? "كلمة المرور (" + "admin" + "123)" : "Mot de passe (" + "admin" + "123)"} value={password} onChange={(e) => setPassword(e.target.value)} required
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

  const filteredArchivedReports = reports
    .filter(r => r.status === "resolved" || r.status === "rejected")
    .filter(r => {
      const searchLower = archiveSearch.toLowerCase();
      const matchesSearch = !archiveSearch || 
        r.locationName.toLowerCase().includes(searchLower) ||
        r.description.toLowerCase().includes(searchLower) ||
        (r.handlingTeamAr && r.handlingTeamAr.toLowerCase().includes(searchLower)) ||
        (r.handlingTeamFr && r.handlingTeamFr.toLowerCase().includes(searchLower)) ||
        (r.reporterName && r.reporterName.toLowerCase().includes(searchLower)) ||
        r.id.toLowerCase().includes(searchLower);

      const matchesWilaya = !archiveWilayaFilter || r.wilaya === archiveWilayaFilter;

      const matchesOutcome = !archiveOutcomeFilter || 
        r.resolvedOutcome === archiveOutcomeFilter ||
        (!r.resolvedOutcome && archiveOutcomeFilter === "extinguished");

      return matchesSearch && matchesWilaya && matchesOutcome;
    });

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
      <div className="flex flex-wrap gap-2 border-b border-white/5 pb-2">
        {[
          { id: "reports", labelAr: "إدارة البلاغات النشطة", labelFr: "Signalements Actifs", icon: <Layers className="h-4 w-4" /> },
          { id: "archive", labelAr: `أرشيف البلاغات المكتملة (${resolvedReports.length})`, labelFr: `Archives Clôturées (${resolvedReports.length})`, icon: <Archive className="h-4 w-4 text-blue-400" /> },
          { 
            id: "sos", 
            labelAr: `استغاثات SOS ${sosCalls.filter(s => s.status === "active").length > 0 ? `(${sosCalls.filter(s => s.status === "active").length})` : ""}`, 
            labelFr: `Alertes SOS ${sosCalls.filter(s => s.status === "active").length > 0 ? `(${sosCalls.filter(s => s.status === "active").length})` : ""}`, 
            icon: (
              <div className="relative">
                <Radio className={`h-4 w-4 ${sosCalls.filter(s => s.status === "active").length > 0 ? "text-red-500 animate-pulse font-black" : ""}`} />
                {sosCalls.filter(s => s.status === "active").length > 0 && (
                  <span className="absolute -top-1 -right-1 h-2 w-2 bg-red-500 rounded-full animate-ping" />
                )}
              </div>
            )
          },
          { id: "badges", labelAr: "رموز الاعتماد", labelFr: "Codes d'accréditation", icon: <BadgeCheck className="h-4 w-4" /> },
          { id: "registrations", labelAr: "طلبات التسجيل", labelFr: "Inscriptions volontaires", icon: <Users className="h-4 w-4" /> },
        ].map((tab) => (
          <button key={tab.id} onClick={() => setAdminTab(tab.id as any)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
              adminTab === tab.id 
                ? tab.id === "sos" && sosCalls.filter(s => s.status === "active").length > 0 
                  ? "bg-red-650 text-white shadow-[0_0_15px_rgba(220,38,38,0.3)] animate-pulse" 
                  : "bg-red-650 text-white" 
                : tab.id === "sos" && sosCalls.filter(s => s.status === "active").length > 0
                  ? "text-red-400 hover:text-red-200 hover:bg-red-500/10 border border-red-500/20"
                  : "text-slate-400 hover:text-slate-200 hover:bg-white/5"
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
                        <button onClick={() => {
                          setResolveModalReport(rep);
                          setResolveTeam("unit_1");
                          setCustomResolveTeam("");
                          setResolveOutcome("extinguished");
                          setResolveNotes("");
                        }}
                          className="p-1.5 bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/20 text-blue-400 rounded-lg text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-all">
                          <CheckCircle2 className="h-3.5 w-3.5" /><span>{isArabic ? "إغلاق وأرشفة" : "Clôturer"}</span>
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

      {/* TAB: ARCHIVE TABLE */}
      {adminTab === "archive" && (
        <div className="space-y-6 animate-fade-in">
          {/* Stats Bar */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div className="bg-zinc-950/40 border border-white/5 p-4 rounded-xl space-y-1">
              <p className="text-[11px] text-gray-400">{isArabic ? "إجمالي البلاغات المؤرشفة" : "Total archivés"}</p>
              <p className="text-2xl font-black text-white">{resolvedReports.length}</p>
            </div>
            <div className="bg-zinc-950/40 border border-emerald-500/10 p-4 rounded-xl space-y-1">
              <p className="text-[11px] text-emerald-400 font-bold">{isArabic ? "تم إخمادها بالكامل" : "Totalement éteints"}</p>
              <p className="text-2xl font-black text-emerald-400">
                {resolvedReports.filter(r => !r.resolvedOutcome || r.resolvedOutcome === 'extinguished').length}
              </p>
            </div>
            <div className="bg-zinc-950/40 border border-blue-500/10 p-4 rounded-xl space-y-1">
              <p className="text-[11px] text-blue-400 font-bold">{isArabic ? "تحت السيطرة / إجلاء" : "Maîtrisés / Évacués"}</p>
              <p className="text-2xl font-black text-blue-400">
                {resolvedReports.filter(r => r.resolvedOutcome === 'contained' || r.resolvedOutcome === 'evacuated').length}
              </p>
            </div>
            <div className="bg-zinc-950/40 border border-purple-500/10 p-4 rounded-xl space-y-1">
              <p className="text-[11px] text-purple-400 font-bold">{isArabic ? "إنذارات ملغاة / مرفوضة" : "Fausses alertes / Rejetés"}</p>
              <p className="text-2xl font-black text-purple-400">
                {reports.filter(r => r.status === "rejected" || r.resolvedOutcome === 'false_alarm').length}
              </p>
            </div>
          </div>

          {/* Table Container */}
          <div className="bg-zinc-900/40 border border-white/5 rounded-2xl p-5 shadow-lg space-y-4">
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 border-b border-white/5 pb-4">
              <div>
                <h3 className="font-extrabold text-sm text-slate-200 flex items-center gap-2">
                  <Archive className="h-5 w-5 text-blue-400" />
                  <span>{isArabic ? "سجل أرشيف البلاغات المكتملة والمغلقة" : "Registre d'Archives des Signalements Clôturés"}</span>
                </h3>
                <p className="text-xs text-gray-400 mt-1">
                  {isArabic ? "مراجعة شاملة لجميع الحرائق التي تم إخمادها والفرق الميدانية التي تولت العمليات" : "Consultation complète des signalements traités et des brigades d'intervention."}
                </p>
              </div>

              {/* Search and Filters */}
              <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
                <div className="relative flex-1 md:w-64">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                  <input
                    type="text"
                    value={archiveSearch}
                    onChange={(e) => setArchiveSearch(e.target.value)}
                    placeholder={isArabic ? "بحث في الأرشيف..." : "Rechercher..."}
                    className="w-full bg-black/50 border border-white/10 rounded-lg py-1.5 pl-9 pr-3 text-xs text-slate-200 placeholder:text-gray-500 focus:outline-none focus:border-blue-500"
                  />
                </div>

                <select
                  value={archiveWilayaFilter}
                  onChange={(e) => setArchiveWilayaFilter(e.target.value)}
                  className="bg-black/50 border border-white/10 rounded-lg py-1.5 px-2.5 text-xs text-slate-300 focus:outline-none focus:border-blue-500 cursor-pointer"
                >
                  <option value="">{isArabic ? "-- كل الولايات --" : "-- Toutes Wilayas --"}</option>
                  {Array.from(new Set(reports.map(r => r.wilaya))).map((w, idx) => (
                    <option key={idx} value={w}>{w}</option>
                  ))}
                </select>

                <select
                  value={archiveOutcomeFilter}
                  onChange={(e) => setArchiveOutcomeFilter(e.target.value)}
                  className="bg-black/50 border border-white/10 rounded-lg py-1.5 px-2.5 text-xs text-slate-300 focus:outline-none focus:border-blue-500 cursor-pointer"
                >
                  <option value="">{isArabic ? "-- جميع النتائج --" : "-- Tous Résultats --"}</option>
                  <option value="extinguished">{isArabic ? "إخماد تام" : "Éteint"}</option>
                  <option value="contained">{isArabic ? "تحت السيطرة" : "Maîtrisé"}</option>
                  <option value="evacuated">{isArabic ? "تم الإجلاء" : "Évacué"}</option>
                  <option value="false_alarm">{isArabic ? "إنذار ملغى" : "Fausse alerte"}</option>
                </select>
              </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-start text-xs border-collapse">
                <thead>
                  <tr className="border-b border-white/10 text-gray-400 text-[11px] font-bold uppercase tracking-wider bg-black/30">
                    <th className="py-3 px-3 text-start">{isArabic ? "البلاغ والموقع" : "Signalement & Lieu"}</th>
                    <th className="py-3 px-3 text-start">{isArabic ? "الراصد والتوقيت" : "Rapporteur & Date"}</th>
                    <th className="py-3 px-3 text-start">{isArabic ? "الفرقة المكلفة" : "Brigade d'Intervention"}</th>
                    <th className="py-3 px-3 text-start">{isArabic ? "نتيجة العملية والإغلاق" : "Résultat & Clôture"}</th>
                    <th className="py-3 px-3 text-center">{isArabic ? "الإجراءات" : "Actions"}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {filteredArchivedReports.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-12 text-center text-gray-500">
                        {isArabic ? "لا توجد بلاغات مكتملة تطابق البحث في الأرشيف." : "Aucun signalement archivé ne correspond aux critères."}
                      </td>
                    </tr>
                  ) : (
                    filteredArchivedReports.map((rep) => {
                      const handlingTeamName = isArabic 
                        ? (rep.handlingTeamAr || "وحدة التدخل الميداني - الحماية المدنية")
                        : (rep.handlingTeamFr || "Unité d'Intervention - Protection Civile");

                      const outcomeKey = rep.resolvedOutcome || "extinguished";
                      let outcomeBadge = {
                        labelAr: "🟢 تم الإخماد والتبريد بالكامل",
                        labelFr: "Éteint et refroidi",
                        bg: "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                      };
                      if (outcomeKey === "contained") {
                        outcomeBadge = {
                          labelAr: "🔵 تحت السيطرة والحراسة",
                          labelFr: "Maîtrisé & Sous surveillance",
                          bg: "bg-blue-500/10 border-blue-500/30 text-blue-400"
                        };
                      } else if (outcomeKey === "evacuated") {
                        outcomeBadge = {
                          labelAr: "🟠 تم إجلاء السكان وتأمين الموقع",
                          labelFr: "Évacué en sécurité",
                          bg: "bg-amber-500/10 border-amber-500/30 text-amber-400"
                        };
                      } else if (outcomeKey === "false_alarm" || rep.status === "rejected") {
                        outcomeBadge = {
                          labelAr: "🔴 إنذار ملغى / بلاغ كاذب",
                          labelFr: "Fausse alerte / Annulé",
                          bg: "bg-purple-500/10 border-purple-500/30 text-purple-400"
                        };
                      }

                      return (
                        <tr key={rep.id} className="hover:bg-white/[0.02] transition-colors group">
                          {/* Location & Image */}
                          <td className="py-3 px-3">
                            <div className="flex items-center gap-3">
                              {rep.image ? (
                                <img
                                  src={rep.image}
                                  alt=""
                                  onClick={() => setSelectedDetailReport(rep)}
                                  className="w-12 h-10 object-cover rounded-lg border border-white/10 shrink-0 cursor-pointer hover:scale-105 transition-transform"
                                  referrerPolicy="no-referrer"
                                />
                              ) : (
                                <div className="w-12 h-10 bg-black/60 rounded-lg border border-white/5 flex items-center justify-center text-lg shrink-0">
                                  🔥
                                </div>
                              )}
                              <div className="space-y-0.5 max-w-[200px]">
                                <h5 className="font-extrabold text-slate-200 truncate group-hover:text-blue-400 transition-colors">
                                  {rep.locationName}
                                </h5>
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="bg-zinc-800 text-gray-300 text-[9px] px-1.5 py-0.2 rounded font-bold">
                                    {rep.wilaya}
                                  </span>
                                  <span className="text-[9px] font-mono text-gray-500">#{rep.id.slice(0, 8)}</span>
                                </div>
                              </div>
                            </div>
                          </td>

                          {/* Reporter Info & Date */}
                          <td className="py-3 px-3">
                            <div className="space-y-0.5">
                              <p className="font-bold text-slate-300 text-[11px] flex items-center gap-1">
                                <User className="h-3 w-3 text-gray-400" />
                                <span>{rep.reporterName || (isArabic ? "مواطن" : "Anonyme")}</span>
                              </p>
                              {rep.reporterPhone && (
                                <p className="text-[10px] text-gray-500 font-mono">{rep.reporterPhone}</p>
                              )}
                              <p className="text-[9px] text-gray-500 flex items-center gap-1 mt-0.5">
                                <Clock className="h-3 w-3 text-gray-500" />
                                <span>{new Date(rep.timestamp).toLocaleString()}</span>
                              </p>
                            </div>
                          </td>

                          {/* Handling Team */}
                          <td className="py-3 px-3">
                            <div className="space-y-1">
                              <span className="inline-flex items-center gap-1.5 bg-sky-950/40 border border-sky-500/20 text-sky-300 text-[11px] px-2.5 py-1 rounded-lg font-bold">
                                <span>🚒</span>
                                <span>{handlingTeamName}</span>
                              </span>
                            </div>
                          </td>

                          {/* Outcome & Closure Notes */}
                          <td className="py-3 px-3">
                            <div className="space-y-1 max-w-[220px]">
                              <span className={`inline-block border text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${outcomeBadge.bg}`}>
                                {isArabic ? outcomeBadge.labelAr : outcomeBadge.labelFr}
                              </span>
                              {rep.resolvedAt && (
                                <p className="text-[9px] text-gray-500 font-mono">
                                  {isArabic ? "تاريخ الإغلاق: " : "Clôturé le: "} {new Date(rep.resolvedAt).toLocaleString()}
                                </p>
                              )}
                              {rep.resolutionNotes && (
                                <p className="text-[10px] text-gray-400 italic truncate" title={rep.resolutionNotes}>
                                  "{rep.resolutionNotes}"
                                </p>
                              )}
                            </div>
                          </td>

                          {/* Actions */}
                          <td className="py-3 px-3">
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                onClick={() => setSelectedDetailReport(rep)}
                                className="p-1.5 bg-black/40 hover:bg-zinc-800 border border-white/10 text-gray-300 hover:text-white rounded-lg text-[10px] font-bold flex items-center gap-1 transition-all cursor-pointer"
                                title={isArabic ? "عرض التقرير الميداني الشامل" : "Voir détail complet"}
                              >
                                <Eye className="h-3.5 w-3.5 text-blue-400" />
                                <span className="hidden lg:inline">{isArabic ? "التفاصيل" : "Détails"}</span>
                              </button>

                              <button
                                onClick={() => updateReportStatus(rep.id, "verified")}
                                className="p-1.5 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 text-amber-400 rounded-lg text-[10px] font-bold flex items-center gap-1 transition-all cursor-pointer"
                                title={isArabic ? "إعادة فتح البلاغ" : "Rouvrir le signalement"}
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                                <span className="hidden lg:inline">{isArabic ? "إعادة فتح" : "Rouvrir"}</span>
                              </button>

                              <button
                                onClick={() => deleteReport(rep.id)}
                                className="p-1.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 rounded-lg text-[10px] font-bold transition-all cursor-pointer"
                                title={isArabic ? "حذف نهائي" : "Supprimer"}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB: SOS CALLS */}
      {adminTab === "sos" && (
        <div className="bg-zinc-900/40 border border-white/5 rounded-2xl p-5 shadow-lg space-y-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-white/5 pb-4">
            <div>
              <h3 className="font-extrabold text-sm text-slate-200 flex items-center gap-2">
                <Radio className="h-5 w-5 text-red-500 animate-pulse" />
                <span>{isArabic ? "إدارة نداءات الاستغاثة SOS العاجلة" : "Gestion des Appels de Détresse SOS"}</span>
              </h3>
              <p className="text-xs text-gray-400 mt-1">
                {isArabic ? "مراقبة مباشرة للأشخاص المحاصرين والمهددين بالنيران" : "Surveillance en temps réel des citoyens piégés par les feux."}
              </p>
            </div>
            <button 
              onClick={onRefresh}
              className="px-3 py-1.5 bg-red-600/10 hover:bg-red-600/20 text-red-400 border border-red-500/20 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all"
            >
              <RefreshCw className="h-3 w-3 animate-spin-slow" />
              <span>{isArabic ? "تحديث فوري" : "Rafraîchir"}</span>
            </button>
          </div>

          {/* Emergency SOS Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-red-950/20 border border-red-500/10 p-4 rounded-xl space-y-1">
              <p className="text-[11px] text-red-400 font-bold">{isArabic ? "الاستغاثات النشطة حالياً" : "Détresses actives"}</p>
              <p className="text-3xl font-black text-red-500 animate-pulse">
                {sosCalls.filter(s => s.status === "active").length}
              </p>
            </div>
            <div className="bg-zinc-950/40 border border-white/5 p-4 rounded-xl space-y-1">
              <p className="text-[11px] text-emerald-400 font-bold">{isArabic ? "الاستغاثات التي تم حلها" : "Résolus / Sauvés"}</p>
              <p className="text-3xl font-black text-emerald-400">
                {sosCalls.filter(s => s.status === "resolved").length}
              </p>
            </div>
            <div className="bg-zinc-950/40 border border-white/5 p-4 rounded-xl space-y-1">
              <p className="text-[11px] text-slate-400">{isArabic ? "مجموع نداءات الاستغاثة" : "Total SOS reçus"}</p>
              <p className="text-3xl font-black text-slate-200">
                {sosCalls.length}
              </p>
            </div>
          </div>

          {/* List of active SOS Calls */}
          <div className="space-y-4">
            <h4 className="text-xs font-extrabold text-red-400 uppercase tracking-wider flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-red-500 animate-ping" />
              <span>{isArabic ? "النداءات العاجلة الجارية" : "Appels de secours en cours"}</span>
            </h4>

            {sosCalls.filter(s => s.status === "active").length === 0 ? (
              <div className="text-center py-12 bg-black/20 border border-white/5 rounded-xl text-xs text-gray-500">
                🎉 {isArabic ? "لا توجد أي استغاثات نشطة حالياً. الجميع آمنون." : "Aucun appel de détresse actif. Tout le monde est en sécurité."}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {sosCalls.filter(s => s.status === "active").map((sos) => {
                  const mapLink = `https://www.google.com/maps/search/?api=1&query=${sos.lat},${sos.lng}`;
                  const relativeTime = new Date(sos.timestamp).toLocaleTimeString();
                  const relativeDate = new Date(sos.timestamp).toLocaleDateString();

                  return (
                    <div key={sos.id} className="bg-red-950/10 border-2 border-red-500/30 hover:border-red-500/60 rounded-xl p-4 flex flex-col justify-between transition-all relative overflow-hidden shadow-lg shadow-red-950/10">
                      {/* Red pulse glow banner */}
                      <div className="absolute top-0 right-0 bg-red-600 text-white text-[9px] font-black px-2.5 py-0.5 rounded-bl-lg uppercase tracking-wider animate-pulse flex items-center gap-1">
                        <span className="h-1.5 w-1.5 bg-white rounded-full animate-ping" />
                        <span>{isArabic ? "نداء نشط" : "ACTIVE SOS"}</span>
                      </div>

                      <div className="space-y-3">
                        <div className="flex items-center gap-2.5">
                          <div className="h-9 w-9 bg-red-600/10 border border-red-500/30 rounded-lg flex items-center justify-center text-red-400">
                            <User className="h-5 w-5" />
                          </div>
                          <div className="text-start">
                            <h5 className="font-extrabold text-slate-100 text-sm">{sos.name}</h5>
                            <p className="text-[10px] text-gray-500 flex items-center gap-1 mt-0.5">
                              <Clock className="h-3 w-3 text-red-400" />
                              <span>{relativeTime} - {relativeDate}</span>
                            </p>
                          </div>
                        </div>

                        {/* Contacts and details */}
                        <div className="bg-black/30 p-2.5 rounded-lg border border-white/5 text-xs space-y-2 text-start">
                          <div className="flex items-center justify-between">
                            <span className="text-gray-400 text-[10px]">{isArabic ? "الهاتف:" : "Téléphone:"}</span>
                            {sos.phone ? (
                              <a href={`tel:${sos.phone}`} className="text-red-400 font-bold hover:underline flex items-center gap-1 font-mono">
                                <Phone className="h-3 w-3" />
                                <span>{sos.phone}</span>
                              </a>
                            ) : (
                              <span className="text-gray-600 italic text-[10px]">
                                {isArabic ? "غير متوفر" : "Non fourni"}
                              </span>
                            )}
                          </div>

                          <div className="flex items-center justify-between border-t border-white/5 pt-1.5">
                            <span className="text-gray-400 text-[10px]">{isArabic ? "الإحداثيات:" : "Coordonnées:"}</span>
                            <span className="text-slate-300 font-mono text-[10px]">
                              {sos.lat.toFixed(6)}, {sos.lng.toFixed(6)}
                            </span>
                          </div>

                          <div className="flex items-center justify-between border-t border-white/5 pt-1.5">
                            <span className="text-gray-400 text-[10px]">{isArabic ? "المعرف الفريد للمتصل:" : "Identifiant:"}</span>
                            <span className="text-gray-500 font-mono text-[9px] truncate max-w-[150px]">
                              {sos.deviceId}
                            </span>
                          </div>
                        </div>

                        {/* SOS Voice Message Audio Player */}
                        {sos.audioUrl ? (
                          <div className="mt-3 bg-red-950/70 border border-red-500/40 rounded-xl p-3 space-y-2 text-start shadow-lg">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5 text-red-400 font-bold text-xs">
                                <Radio className="h-4 w-4 animate-bounce text-red-500" />
                                <span>{isArabic ? "🔊 الاستغاثة الصوتية المسجلة للمحاصر" : "🔊 Enregistrement vocal de détresse"}</span>
                              </div>
                              {sos.audioDuration && (
                                <span className="text-[10px] font-mono bg-red-500/20 text-red-300 px-2 py-0.5 rounded-full border border-red-500/30">
                                  {sos.audioDuration} {isArabic ? "ثانية" : "s"}
                                </span>
                              )}
                            </div>
                            <audio controls src={sos.audioUrl} className="w-full h-9 rounded bg-black/40" />
                          </div>
                        ) : (
                          <div className="mt-2 bg-zinc-900/60 border border-amber-500/20 rounded-lg p-2 text-start text-[10px] text-amber-300/80 flex items-center gap-1.5">
                            <Radio className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                            <span>{isArabic ? "⚠️ استغاثة موقع فقط (بدون تسجيل صوتي)" : "⚠️ Alerte position seule (sans enregistrement)"}</span>
                          </div>
                        )}

                        {/* Dispatched Teams List */}
                        {sos.dispatchedTeams && sos.dispatchedTeams.length > 0 && (
                          <div className="mt-3 space-y-1.5 text-start">
                            <span className="text-[10px] font-extrabold uppercase tracking-wider text-amber-400 block">
                              {isArabic ? "الفرق الموجهة للموقع:" : "Équipes dépêchées:"}
                            </span>
                            {sos.dispatchedTeams.map((team, idx) => (
                              <div key={idx} className="bg-zinc-950 border border-white/5 rounded-lg p-2 text-[11px] flex items-center justify-between">
                                <div className="space-y-0.5">
                                  <p className="font-bold text-slate-200">
                                    {team.type === "protection_civile" ? "🚒 " : "💚 "}
                                    {isArabic ? team.teamNameAr : team.teamNameFr}
                                  </p>
                                  {team.notes && <p className="text-[10px] text-gray-400 italic">"{team.notes}"</p>}
                                </div>
                                <span className="text-[9px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 py-0.5 rounded">
                                  {isArabic ? "في الطريق" : "En route"}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Interactive Dispatcher Action */}
                        <div className="mt-3 border-t border-white/5 pt-3">
                          {dispatchingSosId === sos.id ? (
                            <div className="bg-black/60 border border-red-500/20 rounded-xl p-3 space-y-3 text-start">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-extrabold text-red-400">
                                  {isArabic ? "توجيه نجدة عاجلة" : "Dépêcher des secours"}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => setDispatchingSosId(null)}
                                  className="text-gray-400 hover:text-slate-200 text-xs cursor-pointer font-bold"
                                >
                                  {isArabic ? "إلغاء" : "Annuler"}
                                </button>
                              </div>

                              <div className="space-y-2">
                                <label className="text-[10px] text-gray-400 block">{isArabic ? "نوع الفرقة:" : "Type de brigade:"}</label>
                                <div className="flex gap-2">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setDispatchType('protection_civile');
                                      setSelectedTeam('');
                                    }}
                                    className={`flex-1 py-1 px-2 rounded-lg text-[10px] font-bold border transition-all cursor-pointer ${
                                      dispatchType === 'protection_civile'
                                        ? "bg-red-600/20 border-red-500 text-red-400"
                                        : "bg-black/30 border-white/5 text-gray-400"
                                    }`}
                                  >
                                    🚒 {isArabic ? "الحماية المدنية" : "Prot. Civile"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setDispatchType('volunteers');
                                      setSelectedTeam('');
                                    }}
                                    className={`flex-1 py-1 px-2 rounded-lg text-[10px] font-bold border transition-all cursor-pointer ${
                                      dispatchType === 'volunteers'
                                        ? "bg-emerald-600/20 border-emerald-500 text-emerald-400"
                                        : "bg-black/30 border-white/5 text-gray-400"
                                    }`}
                                  >
                                    💚 {isArabic ? "فرق المتطوعين" : "Volontaires"}
                                  </button>
                                </div>
                              </div>

                              <div className="space-y-2">
                                <label className="text-[10px] text-gray-400 block">{isArabic ? "اختر فرقة التدخل:" : "Choisir l'équipe:"}</label>
                                <select
                                  value={selectedTeam}
                                  onChange={(e) => setSelectedTeam(e.target.value)}
                                  className="w-full bg-zinc-900 border border-white/10 rounded-lg p-2 text-xs text-slate-200 focus:outline-none focus:border-red-500"
                                >
                                  <option value="">-- {isArabic ? "اختر فرقة" : "Sélectionner une équipe"} --</option>
                                  {dispatchType === 'protection_civile' ? (
                                    <>
                                      <option value="unit_1">🚒 {isArabic ? "وحدة التدخل السريع 1" : "Unité Intervention Rapide 1"}</option>
                                      <option value="unit_2">🚒 {isArabic ? "وحدة الدعم والإسناد" : "Unité de Soutien Béjaïa"}</option>
                                      <option value="unit_3">🚒 {isArabic ? "وحدة الإطفاء والإنقاذ الجبلية" : "Unité Mobile feux de forêt"}</option>
                                    </>
                                  ) : (
                                    <>
                                      <option value="vol_1">💚 {isArabic ? "الهلال الأحمر الجزائري" : "Croissant Rouge Algérien"}</option>
                                      <option value="vol_2">💚 {isArabic ? "رابطة المتطوعين للإغاثة" : "Association des Volontaires"}</option>
                                      <option value="vol_3">💚 {isArabic ? "فرقة الدراجات النارية الجبلية" : "Brigade Moto Volontaires"}</option>
                                    </>
                                  )}
                                </select>
                              </div>

                              <div className="space-y-2">
                                <label className="text-[10px] text-gray-400 block">{isArabic ? "ملاحظات التوجيه (اختياري):" : "Notes de déploiement (Optionnel):"}</label>
                                <input
                                  type="text"
                                  value={dispatchNotes}
                                  onChange={(e) => setDispatchNotes(e.target.value)}
                                  placeholder={isArabic ? "مثال: توجهوا من الممر الشمالي الآمن..." : "Ex: Avancez par le couloir nord sécurisé..."}
                                  className="w-full bg-zinc-900 border border-white/10 rounded-lg p-2 text-xs text-slate-200 focus:outline-none focus:border-red-500"
                                />
                              </div>

                              <button
                                type="button"
                                disabled={loading || !selectedTeam}
                                onClick={() => handleDispatchSubmit(sos.id)}
                                className="w-full bg-red-600 hover:bg-red-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg py-1.5 text-xs font-bold transition-all cursor-pointer"
                              >
                                {isArabic ? "توجيه فرقة النجدة الآن" : "Déployer la brigade"}
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setDispatchingSosId(sos.id);
                                setDispatchType('protection_civile');
                                setSelectedTeam('');
                                setDispatchNotes('');
                              }}
                              className="w-full bg-red-600/10 hover:bg-red-600/20 text-red-400 border border-red-500/20 rounded-lg py-2 text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                            >
                              <Radio className="h-4 w-4 text-red-500 animate-pulse" />
                              <span>{isArabic ? "توجيه طاقم حماية مدنية أو متطوعين" : "Diriger / Dépêcher des Secours"}</span>
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Control buttons */}
                      <div className="flex gap-2 mt-4 pt-3 border-t border-white/5">
                        <a 
                          href={mapLink} 
                          target="_blank" 
                          rel="noreferrer" 
                          className="flex-1 bg-black/40 hover:bg-zinc-800 border border-white/10 rounded-lg py-2 text-[10px] font-bold text-center text-slate-300 transition-colors flex items-center justify-center gap-1 cursor-pointer"
                        >
                          <MapPin className="h-3 w-3 text-red-500 animate-pulse" />
                          <span>{isArabic ? "فتح في خرائط جوجل" : "Ouvrir dans Maps"}</span>
                        </a>
                        <button
                          onClick={async () => {
                            if (confirm(isArabic ? `هل تؤكد أنه تم إنقاذ ${sos.name} بأمان وتم حل هذا النداء؟` : `Confirmez-vous que ${sos.name} a été secouru avec succès ?`)) {
                              try {
                                const res = await fetch(`/api/sos/${sos.id}/resolve`, { method: "POST" });
                                if (res.ok) onRefresh();
                              } catch (err) { console.error(err); }
                            }
                          }}
                          className="flex-1 bg-emerald-650 hover:bg-emerald-600 text-white rounded-lg py-2 text-[10px] font-bold transition-all flex items-center justify-center gap-1 cursor-pointer"
                        >
                          <Check className="h-3.5 w-3.5" />
                          <span>{isArabic ? "تم الإنقاذ والحل" : "Sauvé & Résolu"}</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* List of resolved/completed SOS calls */}
          {sosCalls.filter(s => s.status === "resolved").length > 0 && (
            <div className="border-t border-white/5 pt-5 space-y-3">
              <h4 className="text-xs font-bold text-slate-400">
                {isArabic ? "سجل النداءات التي تم حلها بنجاح (المواطنون الذين تم إنقاذهم)" : "Historique des alertes résolues (Citoyens Secourus)"}
              </h4>
              <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                {sosCalls.filter(s => s.status === "resolved").map((sos) => (
                  <div key={sos.id} className="bg-emerald-950/5 border border-emerald-500/10 rounded-xl p-3 flex items-center justify-between text-start">
                    <div className="flex items-center gap-3">
                      <div className="h-7 w-7 bg-emerald-600/10 rounded-lg flex items-center justify-center text-emerald-400">
                        <Check className="h-4 w-4" />
                      </div>
                      <div>
                        <h5 className="font-bold text-xs text-slate-300">{sos.name}</h5>
                        <p className="text-[9px] text-gray-500">
                          {isArabic ? "تم الحل في: " : "Résolu le: "} {new Date(sos.timestamp).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full uppercase">
                        {isArabic ? "آمن" : "Secouru"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
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
              <input value={newPhone} onChange={e => setNewPhone(e.target.value)} placeholder={isArabic ? "رقم الهاتف (اختياري)" : "N° de téléphone (optionnel)"}
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

      {/* RESOLVE / CLOSE REPORT MODAL */}
      {resolveModalReport && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-zinc-950 border border-white/10 rounded-2xl max-w-lg w-full p-6 space-y-5 shadow-2xl relative text-start">
            <button
              onClick={() => setResolveModalReport(null)}
              className="absolute top-4 left-4 text-gray-400 hover:text-white text-lg font-bold p-1 cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>

            <div className="flex items-center gap-3 border-b border-white/10 pb-4">
              <div className="h-10 w-10 bg-blue-600/20 border border-blue-500/30 rounded-xl flex items-center justify-center text-blue-400">
                <CheckCircle2 className="h-6 w-6" />
              </div>
              <div>
                <h3 className="font-extrabold text-base text-slate-100">
                  {isArabic ? "إغلاق البلاغ وأرشفته في النظام" : "Clôturer & Archiver le Signalement"}
                </h3>
                <p className="text-xs text-gray-400">
                  {resolveModalReport.locationName} ({resolveModalReport.wilaya})
                </p>
              </div>
            </div>

            <form onSubmit={handleResolveSubmit} className="space-y-4 text-xs">
              {/* Handling Team Selector */}
              <div className="space-y-1.5">
                <label className="block font-bold text-gray-300">
                  {isArabic ? "1. الفرقة / الطاقم الميداني الذي تولى التدخل:" : "1. Brigade / Équipe d'intervention :"}
                </label>
                <select
                  value={resolveTeam}
                  onChange={(e) => setResolveTeam(e.target.value)}
                  className="w-full bg-zinc-900 border border-white/10 rounded-xl p-2.5 text-xs text-slate-100 focus:outline-none focus:border-blue-500 cursor-pointer"
                >
                  <option value="unit_1">🚒 {isArabic ? "وحدة التدخل السريع - الحماية المدنية 1" : "Unité Intervention Rapide 1"}</option>
                  <option value="unit_2">🚒 {isArabic ? "وحدة الدعم والإسناد - الحماية المدنية بجاية" : "Unité de Soutien Béjaïa"}</option>
                  <option value="unit_3">🚒 {isArabic ? "وحدة الإطفاء والإنقاذ الجبلية" : "Unité Mobile Feux de Forêt"}</option>
                  <option value="vol_1">💚 {isArabic ? "مجموعة الهلال الأحمر الجزائري - متطوعي الإغاثة" : "Groupe Croissant Rouge Algérien"}</option>
                  <option value="vol_2">💚 {isArabic ? "رابطة المتطوعين والشباب المحلي للإغاثة" : "Association des Jeunes Volontaires"}</option>
                  <option value="vol_3">💚 {isArabic ? "فرقة الدراجات النارية الجبلية للمتطوعين" : "Brigade Moto Volontaires"}</option>
                  <option value="custom">✍️ {isArabic ? "فرقة أجنبية / جهة مخصصة..." : "Saisir une autre équipe..."}</option>
                </select>

                {resolveTeam === "custom" && (
                  <input
                    type="text"
                    value={customResolveTeam}
                    onChange={(e) => setCustomResolveTeam(e.target.value)}
                    placeholder={isArabic ? "ادخل اسم الفرقة أو الجهة المتدخلة..." : "Nom de la brigade d'intervention..."}
                    required
                    className="w-full bg-zinc-900 border border-white/10 rounded-xl p-2.5 text-xs text-slate-100 mt-2 focus:outline-none focus:border-blue-500"
                  />
                )}
              </div>

              {/* Final Outcome Selector */}
              <div className="space-y-1.5">
                <label className="block font-bold text-gray-300">
                  {isArabic ? "2. النتيجة النهائية للتدخل الميداني:" : "2. Résultat final de l'intervention :"}
                </label>
                <select
                  value={resolveOutcome}
                  onChange={(e) => setResolveOutcome(e.target.value)}
                  className="w-full bg-zinc-900 border border-white/10 rounded-xl p-2.5 text-xs text-slate-100 focus:outline-none focus:border-blue-500 cursor-pointer"
                >
                  <option value="extinguished">🟢 {isArabic ? "تم الإخماد والتبريد بالكامل" : "Éteint & Refroidi"}</option>
                  <option value="contained">🔵 {isArabic ? "تحت السيطرة والحراسة الميدانية" : "Maîtrisé & Sous Surveillance"}</option>
                  <option value="evacuated">🟠 {isArabic ? "تم إجلاء السكان وتأمين الموقع" : "Évacué en sécurité"}</option>
                  <option value="false_alarm">🔴 {isArabic ? "إنذار ملغى / بلاغ غير دقيق" : "Fausse alerte / Annulé"}</option>
                </select>
              </div>

              {/* Resolution Notes */}
              <div className="space-y-1.5">
                <label className="block font-bold text-gray-300">
                  {isArabic ? "3. ملاحظات وتقريب التقرير الميداني (اختياري):" : "3. Remarques / Rapport de clôture (Optionnel) :"}
                </label>
                <textarea
                  rows={3}
                  value={resolveNotes}
                  onChange={(e) => setResolveNotes(e.target.value)}
                  placeholder={isArabic ? "مثال: تم إخلاء المنطقة بنجاح وسيطرت الحماية المدنية على ألسنة اللهب قبل وصولها للقرية..." : "Remarques sur l'intervention..."}
                  className="w-full bg-zinc-900 border border-white/10 rounded-xl p-2.5 text-xs text-slate-100 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="flex gap-2 pt-2 border-t border-white/10">
                <button
                  type="button"
                  onClick={() => setResolveModalReport(null)}
                  className="flex-1 py-2.5 bg-black/40 hover:bg-zinc-800 text-gray-300 rounded-xl font-bold cursor-pointer transition-colors"
                >
                  {isArabic ? "إلغاء" : "Annuler"}
                </button>
                <button
                  type="submit"
                  disabled={updatingId === resolveModalReport.id}
                  className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-bold transition-colors flex items-center justify-center gap-1.5 cursor-pointer shadow-lg shadow-blue-600/20"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  <span>{isArabic ? "إغلاق وأرشفة البلاغ" : "Valider la clôture"}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* AUDIT / DETAIL INSPECTION MODAL */}
      {selectedDetailReport && (
        <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-4 animate-fade-in overflow-y-auto">
          <div className="bg-zinc-950 border border-white/10 rounded-2xl max-w-2xl w-full p-6 space-y-5 shadow-2xl relative text-start my-8">
            <button
              onClick={() => setSelectedDetailReport(null)}
              className="absolute top-4 left-4 text-gray-400 hover:text-white text-lg font-bold p-1.5 bg-black/40 rounded-lg cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>

            <div className="flex items-center gap-3 border-b border-white/10 pb-4">
              <div className="h-10 w-10 bg-blue-600/20 border border-blue-500/30 rounded-xl flex items-center justify-center text-blue-400">
                <FileText className="h-6 w-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-extrabold text-base text-slate-100">
                    {selectedDetailReport.locationName}
                  </h3>
                  <span className="bg-blue-500/10 text-blue-400 border border-blue-500/20 text-[9px] font-bold px-2 py-0.5 rounded uppercase">
                    {isArabic ? "بلاغ مؤرشف" : "Signalement Archivé"}
                  </span>
                </div>
                <p className="text-xs text-gray-400 mt-0.5">
                  {selectedDetailReport.wilaya} | ID: {selectedDetailReport.id}
                </p>
              </div>
            </div>

            <div className="space-y-4 text-xs">
              {/* Image if available */}
              {selectedDetailReport.image && (
                <div className="rounded-xl overflow-hidden border border-white/10 bg-black max-h-64 flex items-center justify-center">
                  <img
                    src={selectedDetailReport.image}
                    alt=""
                    className="w-full h-full object-contain max-h-64"
                    referrerPolicy="no-referrer"
                  />
                </div>
              )}

              {/* Handling Team & Outcome Info */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-zinc-900/60 p-3.5 rounded-xl border border-white/5">
                <div>
                  <span className="text-[10px] text-gray-400 font-bold uppercase block mb-1">
                    {isArabic ? "الفرقة المباشرة للعملية:" : "Brigade d'intervention :"}
                  </span>
                  <p className="font-extrabold text-sky-400 flex items-center gap-1.5 text-sm">
                    <span>🚒</span>
                    <span>
                      {isArabic 
                        ? (selectedDetailReport.handlingTeamAr || "وحدة التدخل السريع - الحماية المدنية")
                        : (selectedDetailReport.handlingTeamFr || "Unité d'Intervention Rapide")}
                    </span>
                  </p>
                </div>

                <div>
                  <span className="text-[10px] text-gray-400 font-bold uppercase block mb-1">
                    {isArabic ? "النتيجة النهائية:" : "Résultat final :"}
                  </span>
                  <p className="font-extrabold text-emerald-400 text-sm">
                    {selectedDetailReport.resolvedOutcome === "contained" ? (isArabic ? "🔵 تحت السيطرة والحراسة" : "Maîtrisé") :
                     selectedDetailReport.resolvedOutcome === "evacuated" ? (isArabic ? "🟠 تم الإجلاء وتأمين الموقع" : "Évacué") :
                     selectedDetailReport.resolvedOutcome === "false_alarm" ? (isArabic ? "🔴 إنذار ملغى" : "Fausse alerte") :
                     (isArabic ? "🟢 تم الإخماد والتبريد بالكامل" : "Éteint et refroidi")}
                  </p>
                </div>
              </div>

              {/* Original Description */}
              <div className="bg-black/40 p-3.5 rounded-xl border border-white/5 space-y-1">
                <span className="text-[10px] text-gray-400 font-bold uppercase block">
                  {isArabic ? "وصف البلاغ الميداني الأصلي:" : "Description initiale :"}
                </span>
                <p className="text-slate-200 leading-relaxed font-sans">{selectedDetailReport.description}</p>
              </div>

              {/* Closure Notes */}
              {selectedDetailReport.resolutionNotes && (
                <div className="bg-blue-950/20 p-3.5 rounded-xl border border-blue-500/20 space-y-1">
                  <span className="text-[10px] text-blue-400 font-bold uppercase block">
                    {isArabic ? "ملاحظات تقرير الإغلاق:" : "Rapport de clôture :"}
                  </span>
                  <p className="text-blue-200 italic font-sans">"{selectedDetailReport.resolutionNotes}"</p>
                </div>
              )}

              {/* Metadata Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-[11px]">
                <div className="bg-black/30 p-2.5 rounded-lg border border-white/5">
                  <span className="text-gray-500 block text-[9px]">{isArabic ? "الراصد:" : "Rapporteur:"}</span>
                  <span className="font-bold text-slate-200">{selectedDetailReport.reporterName || "مواطن"} ({selectedDetailReport.reporterType})</span>
                </div>

                <div className="bg-black/30 p-2.5 rounded-lg border border-white/5">
                  <span className="text-gray-500 block text-[9px]">{isArabic ? "الهاتف:" : "Téléphone:"}</span>
                  <span className="font-mono font-bold text-slate-200">{selectedDetailReport.reporterPhone || "غير متوفر"}</span>
                </div>

                <div className="bg-black/30 p-2.5 rounded-lg border border-white/5">
                  <span className="text-gray-500 block text-[9px]">{isArabic ? "تاريخ الإبلاغ:" : "Date signalement:"}</span>
                  <span className="font-mono text-slate-300 text-[10px]">{new Date(selectedDetailReport.timestamp).toLocaleString()}</span>
                </div>
              </div>

              {/* Google Maps link */}
              <div className="flex gap-2 pt-2">
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${selectedDetailReport.lat},${selectedDetailReport.lng}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 py-2.5 bg-black/50 hover:bg-zinc-800 border border-white/10 rounded-xl font-bold text-slate-200 transition-colors flex items-center justify-center gap-2 cursor-pointer"
                >
                  <MapPin className="h-4 w-4 text-red-500" />
                  <span>{isArabic ? "عرض الموقع الجغرافي على الخريطة" : "Voir sur Google Maps"}</span>
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
