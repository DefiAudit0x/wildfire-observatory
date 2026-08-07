import { useState, useEffect, useCallback } from "react";
import { Lock, ShieldCheck, Users, Landmark, Plus, Trash2, RefreshCw, KeyRound, AlertTriangle, LogOut, Eye, EyeOff, Unlock } from "lucide-react";
import { Language } from "../../types";

interface Unit {
  id: string;
  code: string;
  nameAr: string;
  nameFr: string;
  wilaya: string;
}

interface StaffUser {
  agentId: string;
  name: string;
  role: "superadmin" | "commander" | "agent";
  unitId: string;
  isActive: boolean;
  createdAt?: string;
}

interface SessionInfo {
  agentId: string | null;
  name: string | null;
  role: string;
  unitId: string | null;
}

interface StaffManagerProps {
  lang: Language;
  adminToken?: string | null;
}

function roleLabel(role: string, isArabic: boolean): string {
  const map: Record<string, string> = {
    superadmin: isArabic ? "مشرف عام" : "Super Admin",
    commander: isArabic ? "قائد وحدة" : "Chef d'unité",
    agent: isArabic ? "فعال / مناوب" : "Agent",
    admin: isArabic ? "إداري" : "Admin",
  };
  return map[role] || role;
}

export default function StaffManager({ lang, adminToken }: StaffManagerProps) {
  const isArabic = lang === "ar";
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [authChecking, setAuthChecking] = useState(true);

  const [agentId, setAgentId] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  const [units, setUnits] = useState<Unit[]>([]);
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [unitForm, setUnitForm] = useState({ code: "", nameAr: "", nameFr: "", wilaya: "" });
  const [userForm, setUserForm] = useState({ agentId: "", name: "", role: "agent", unitId: "", password: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const getToken = () => {
    // Staff login token first; fall back to the superadmin panel token when present.
    return sessionStorage.getItem("staff_token") || adminToken || null;
  };

  const handleAuth = (res: Response) => {
    if (res.status === 401 || res.status === 403) {
      setSession(null);
      sessionStorage.removeItem("staff_token");
      return true;
    }
    return false;
  };

  const probeSession = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/session", {
        headers: { Authorization: `Bearer ${getToken()}` },
        credentials: "same-origin",
      });
      if (res.ok) {
        const data = await res.json();
        setSession(data.user);
      } else {
        setSession(null);
      }
    } catch {
      setSession(null);
    } finally {
      setAuthChecking(false);
    }
  }, []);

  useEffect(() => {
    probeSession();
  }, [probeSession]);

  const fetchUnits = useCallback(async () => {
    try {
      const res = await fetch("/api/units", {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (res.ok) {
        const data = await res.json();
        setUnits(Array.isArray(data.units) ? data.units : []);
      }
    } catch (err) {
      console.error("Failed to load units", err);
    }
  }, []);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch("/api/users", {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (res.ok) {
        const data = await res.json();
        setUsers(Array.isArray(data.users) ? data.users : []);
      }
    } catch (err) {
      console.error("Failed to load users", err);
    }
  }, []);

  const loadAll = useCallback(async () => {
    await Promise.all([fetchUnits(), fetchUsers()]);
    setLoaded(true);
  }, [fetchUnits, fetchUsers]);

  useEffect(() => {
    if (session) {
      loadAll();
    } else {
      setLoaded(false);
      setUsers([]);
      setUnits([]);
    }
  }, [session, loadAll]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!agentId.trim() || !password) {
      setError(isArabic ? "أدخل معرف الوكيل وكلمة المرور." : "Entrez l'identifiant et le mot de passe.");
      return;
    }
    setLoginLoading(true);
    setMsg(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: agentId.trim(), password }),
      });
      const data = await res.json();
      if (res.ok && data.token) {
        sessionStorage.setItem("staff_token", data.token);
        setAgentId("");
        setPassword("");
        await probeSession();
      } else {
        setError(isArabic ? "بيانات الدخول غير صحيحة أو الحساب موقوف." : "Identifiants invalides ou compte désactivé.");
      }
    } catch {
      setError(isArabic ? "تعذر الاتصال بالخادم." : "Erreur de connexion au serveur.");
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    sessionStorage.removeItem("staff_token");
    setSession(null);
    fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  };

  const apiFetch = async (url: string, method: string, body?: unknown) => {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  };

  const handleAddUnit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch("/api/units", "POST", {
        code: unitForm.code.trim(),
        nameAr: unitForm.nameAr.trim(),
        nameFr: unitForm.nameFr.trim(),
        wilaya: unitForm.wilaya.trim(),
      });
      const data = await res.json();
      if (res.ok || res.status === 201) {
        setUnitForm({ code: "", nameAr: "", nameFr: "", wilaya: "" });
        await fetchUnits();
        setMsg(isArabic ? "✓ تمت إضافة الوحدة." : "✓ Unité ajoutée.");
      } else {
        setMsg(isArabic ? (data.error || "فشل الإضافة") : (data.error || "Échec de l'ajout"));
      }
    } catch {
      setMsg(isArabic ? "خطأ في الاتصال." : "Erreur de connexion.");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteUnit = async (unit: Unit) => {
    if (!confirm(isArabic ? `حذف وحدة "${unit.nameAr}" نهائياً؟` : `Supprimer l'unité "${unit.nameFr}" ?`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch(`/api/units/${unit.id}`, "DELETE");
      if (res.ok) {
        await Promise.all([fetchUnits(), fetchUsers()]);
        setMsg(isArabic ? "✓ تم حذف الوحدة." : "✓ Unité supprimée.");
      } else {
        const data = await res.json().catch(() => ({}));
        setMsg(isArabic ? (data.error || "فشل الحذف") : (data.error || "Échec de la suppression"));
      }
    } catch {
      setMsg(isArabic ? "خطأ في الاتصال." : "Erreur de connexion.");
    } finally {
      setBusy(false);
    }
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch("/api/users", "POST", {
        agentId: userForm.agentId.trim(),
        name: userForm.name.trim(),
        role: userForm.role,
        unitId: userForm.unitId,
        password: userForm.password,
      });
      const data = await res.json();
      if (res.ok || res.status === 201) {
        setUserForm({ agentId: "", name: "", role: "agent", unitId: "", password: "" });
        await fetchUsers();
        setMsg(isArabic ? "✓ تم إنشاء الحساب." : "✓ Compte créé.");
      } else {
        setMsg(isArabic ? (data.error || "فشل الإنشاء") : (data.error || "Échec de la création"));
      }
    } catch {
      setMsg(isArabic ? "خطأ في الاتصال." : "Erreur de connexion.");
    } finally {
      setBusy(false);
    }
  };

  const handleToggleUser = async (user: StaffUser) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch(`/api/users/${user.agentId}`, "PUT", { isActive: !user.isActive });
      if (res.ok) {
        await fetchUsers();
      } else {
        const data = await res.json().catch(() => ({}));
        setMsg(isArabic ? (data.error || "فشل التحديث") : (data.error || "Échec de la mise à jour"));
      }
    } catch {
      setMsg(isArabic ? "خطأ في الاتصال." : "Erreur de connexion.");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteUser = async (user: StaffUser) => {
    if (!confirm(isArabic ? `حذف حساب "${user.name}" نهائياً؟` : `Supprimer le compte de "${user.name}" ?`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch(`/api/users/${user.agentId}`, "DELETE");
      if (res.ok) {
        await fetchUsers();
        setMsg(isArabic ? "✓ تم حذف الحساب." : "✓ Compte supprimé.");
      } else {
        const data = await res.json().catch(() => ({}));
        setMsg(isArabic ? (data.error || "فشل الحذف") : (data.error || "Échec de la suppression"));
      }
    } catch {
      setMsg(isArabic ? "خطأ في الاتصال." : "Erreur de connexion.");
    } finally {
      setBusy(false);
    }
  };

  if (authChecking) {
    return (
      <div className="text-center py-12">
        <RefreshCw className="h-6 w-6 animate-spin mx-auto text-slate-400" />
        <p className="text-xs text-gray-500 mt-3">{isArabic ? "جارٍ التحقق من الجلسة..." : "Vérification de la session..."}</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div id="staff-login-card" className="max-w-md mx-auto my-8 bg-zinc-950/80 border border-white/5 rounded-2xl p-8 shadow-[0_10px_50px_rgba(0,0,0,0.8)] text-center space-y-6">
        <div className="mx-auto w-16 h-16 bg-sky-600/10 border border-sky-500/20 rounded-2xl flex items-center justify-center text-sky-400">
          <ShieldCheck className="h-8 w-8" />
        </div>
        <div>
          <h2 className="text-xl font-extrabold tracking-tight text-slate-100">
            {isArabic ? "دخول الكادر والوحدات" : "Accès Personnel & Unités"}
          </h2>
          <p className="text-xs text-gray-400 mt-1.5 leading-normal">
            {isArabic
              ? "دخول خاص بأفراد الحماية المدنية (الوكلاء والقادة). المدير العام يدخل من لوحة التحكم الأمنية الرئيسية."
              : "Accès réservé au personnel de la protection civile (agents et chefs d'unité)."}
          </p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div className="relative">
            <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
            <input
              type="text"
              placeholder={isArabic ? "معرف الوكيل (agentId)" : "Identifiant Agent"}
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              autoCapitalize="none"
              className="w-full bg-black/50 border border-white/10 rounded-xl py-3 pl-11 pr-4 text-sm text-slate-200 placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-sky-600 transition-all font-mono text-center"
            />
          </div>
          <div className="relative">
            <KeyRound className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
            <input
              type={showPw ? "text" : "password"}
              placeholder={isArabic ? "كلمة المرور" : "Mot de passe"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-black/50 border border-white/10 rounded-xl py-3 pl-11 pr-11 text-sm text-slate-200 placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-red-650 transition-all font-mono text-center"
            />
            <button
              type="button"
              onClick={() => setShowPw((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 cursor-pointer"
              tabIndex={-1}
            >
              {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          {error && (
            <p className="text-xs font-bold text-red-500 flex items-center gap-1.5 justify-center bg-red-500/5 py-2 rounded-lg border border-red-500/10">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </p>
          )}

          <button
            type="submit"
            disabled={loginLoading}
            className="w-full py-3 bg-sky-700 hover:bg-sky-600 text-white rounded-xl text-xs font-black tracking-wider uppercase shadow-lg shadow-sky-700/10 transition-all flex items-center justify-center gap-2 cursor-pointer"
          >
            {loginLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <><Unlock className="h-4 w-4" /> <span>{isArabic ? "دخول" : "Connexion"}</span></>}
          </button>
        </form>
      </div>
    );
  }

  const isSuper = session.role === "superadmin" || session.role === "admin";

  return (
    <div className="space-y-5 w-full animate-fade-in">
      {/* Session header */}
      <div className="bg-zinc-900/50 border border-white/5 p-4 rounded-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 bg-sky-600/10 border border-sky-500/20 rounded-xl flex items-center justify-center text-sky-400">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-black text-sm text-slate-100">{session.name || session.agentId}</h3>
              <span className="bg-sky-700 text-white text-[9px] font-bold px-2 py-0.5 rounded-full uppercase">
                {roleLabel(session.role, isArabic)}
              </span>
            </div>
            <p className="text-[11px] text-gray-400 mt-0.5">
              {session.agentId && <span className="font-mono">{session.agentId} · </span>}
              {isSuper
                ? (isArabic ? "صلاحيات مركزية كاملة" : "Accès central complet")
                : (isArabic ? "مرتبط بوحدته فقط" : "Limité à son unité")}
            </p>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="px-4 py-2 bg-red-650 hover:bg-red-700 text-white rounded-xl text-xs font-black transition-colors flex items-center gap-1.5 cursor-pointer"
        >
          <LogOut className="h-3.5 w-3.5" />
          <span>{isArabic ? "خروج" : "Déconnexion"}</span>
        </button>
      </div>

      {/* Units management — superadmin only */}
      {isSuper && (
        <div className="bg-zinc-900/40 border border-white/5 rounded-2xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Landmark className="h-4 w-4 text-amber-400" />
            <h3 className="font-extrabold text-sm text-slate-200">
              {isArabic ? "إدارة وحدات الحماية المدنية" : "Gestion des unités"}
            </h3>
          </div>

          <form onSubmit={handleAddUnit} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <input
              value={unitForm.code}
              onChange={(e) => setUnitForm((f) => ({ ...f, code: e.target.value }))}
              placeholder={isArabic ? "رمز الوحدة (مثال DZ16)" : "Code (ex: DZ16)"}
              className="bg-black/50 border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder:text-gray-600 font-mono focus:ring-1 focus:ring-amber-500/40"
            />
            <input
              value={unitForm.nameAr}
              onChange={(e) => setUnitForm((f) => ({ ...f, nameAr: e.target.value }))}
              placeholder={isArabic ? "الاسم بالعربية" : "Nom en arabe"}
              className="bg-black/50 border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder:text-gray-600 focus:ring-1 focus:ring-amber-500/40"
            />
            <input
              value={unitForm.nameFr}
              onChange={(e) => setUnitForm((f) => ({ ...f, nameFr: e.target.value }))}
              placeholder={isArabic ? "الاسم بالفرنسية" : "Nom en français"}
              className="bg-black/50 border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder:text-gray-600 focus:ring-1 focus:ring-amber-500/40"
            />
            <input
              value={unitForm.wilaya}
              onChange={(e) => setUnitForm((f) => ({ ...f, wilaya: e.target.value }))}
              placeholder={isArabic ? "الولاية" : "Wilaya"}
              className="bg-black/50 border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder:text-gray-600 focus:ring-1 focus:ring-amber-500/40"
            />
            <button
              type="submit"
              disabled={busy}
              className="px-3 py-2 bg-amber-600/15 hover:bg-amber-600/25 border border-amber-500/30 text-amber-400 rounded-xl text-xs font-black flex items-center justify-center gap-1.5 cursor-pointer transition-all"
            >
              <Plus className="h-4 w-4" />
              <span>{isArabic ? "إضافة" : "Ajouter"}</span>
            </button>
          </form>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {units.map((unit) => (
              <div key={unit.id} className="bg-black/40 border border-white/5 rounded-xl p-3.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="bg-amber-500/10 text-amber-400 font-mono text-[10px] px-2 py-0.5 rounded">{unit.code}</span>
                    <h4 className="font-bold text-xs text-slate-100 truncate">{unit.nameAr}</h4>
                  </div>
                  <p className="text-[10px] text-gray-400 mt-1 truncate">{unit.nameFr} · {unit.wilaya}</p>
                </div>
                <button
                  onClick={() => handleDeleteUnit(unit)}
                  disabled={busy}
                  className="p-2 bg-zinc-900 hover:bg-red-650/25 border border-white/5 text-gray-400 hover:text-red-400 rounded-lg cursor-pointer transition-colors"
                  title={isArabic ? "حذف الوحدة" : "Supprimer l'unité"}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {units.length === 0 && (
              <p className="text-xs text-gray-500 text-center py-6 col-span-full">
                {isArabic ? "لا توجد وحدات بعد." : "Aucune unité enregistrée."}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Staff accounts — superadmin full listing; commander sees own unit */}
      <div className="bg-zinc-900/40 border border-white/5 rounded-2xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-emerald-400" />
          <h3 className="font-extrabold text-sm text-slate-200">
            {isArabic ? "حسابات الكادر" : "Comptes du personnel"}
          </h3>
          {!isSuper && <span className="text-[10px] text-gray-500">{isArabic ? "(وحدتك فقط)" : "(votre unité)"}</span>}
        </div>

        {(isSuper || session.role === "commander") && (
          <form onSubmit={handleAddUser} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
            <input
              value={userForm.agentId}
              onChange={(e) => setUserForm((f) => ({ ...f, agentId: e.target.value }))}
              placeholder={isArabic ? "معرف الوكيل" : "Agent ID"}
              className="bg-black/50 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder:text-gray-600 font-mono focus:ring-1 focus:ring-emerald-500/40"
            />
            <input
              value={userForm.name}
              onChange={(e) => setUserForm((f) => ({ ...f, name: e.target.value }))}
              placeholder={isArabic ? "الاسم الكامل" : "Nom complet"}
              className="bg-black/50 border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder:text-gray-600 focus:ring-1 focus:ring-emerald-500/40"
            />
            <select
              value={userForm.role}
              onChange={(e) => setUserForm((f) => ({ ...f, role: e.target.value }))}
              className="bg-black/50 border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-300 font-bold focus:ring-1 focus:ring-emerald-500/40 focus:outline-none cursor-pointer"
              disabled={!isSuper}
            >
              <option value="agent">{isArabic ? "فعال / مناوب" : "Agent"}</option>
              <option value="commander">{isArabic ? "قائد وحدة" : "Commander"}</option>
              {isSuper && <option value="superadmin">{isArabic ? "مشرف عام" : "Super Admin"}</option>}
            </select>
            <select
              value={userForm.unitId}
              onChange={(e) => setUserForm((f) => ({ ...f, unitId: e.target.value }))}
              className="bg-black/50 border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-300 font-bold focus:ring-1 focus:ring-emerald-500/40 focus:outline-none cursor-pointer"
            >
              <option value="">{isArabic ? "— الوحدة —" : "— Unité —"}</option>
              {units.map((u) => (
                <option key={u.id} value={u.code}>
                  {u.code} · {isArabic ? u.nameAr : u.nameFr}
                </option>
              ))}
            </select>
            <input
              type="password"
              value={userForm.password}
              onChange={(e) => setUserForm((f) => ({ ...f, password: e.target.value }))}
              placeholder={isArabic ? "كلمة مرور (8+)" : "Mot de passe (8+)"}
              className="bg-black/50 border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder:text-gray-600 font-mono focus:ring-1 focus:ring-emerald-500/40"
            />
            <button
              type="submit"
              disabled={busy}
              className="px-3 py-2 bg-emerald-600/15 hover:bg-emerald-600/25 border border-emerald-500/30 text-emerald-400 rounded-xl text-xs font-black flex items-center justify-center gap-1.5 cursor-pointer transition-all"
            >
              <Plus className="h-4 w-4" />
              <span>{isArabic ? "إنشاء" : "Créer"}</span>
            </button>
          </form>
        )}

        {msg && <p className="text-xs text-slate-400 bg-white/5 border border-white/10 px-3 py-2 rounded-lg">{msg}</p>}

        <div className="space-y-2">
          {users.length === 0 && loaded ? (
            <p className="text-xs text-gray-600 text-center py-4">
              {isArabic ? "لا توجد حسابات كادر بعد." : "Aucun compte enregistré."}
            </p>
          ) : (
            users.map((user) => (
              <div key={user.agentId} className="bg-gray-800/40 border border-white/5 rounded-xl px-3.5 py-2.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[10px] text-gray-500">{user.agentId}</span>
                    <span className="text-xs font-bold text-slate-100">{user.name}</span>
                    <span className={`text-[9px] px-2 py-0.5 rounded font-bold uppercase ${
                      user.role === "commander" ? "bg-amber-500/10 text-amber-400"
                      : user.role === "superadmin" ? "bg-purple-500/10 text-purple-400"
                      : "bg-emerald-500/10 text-emerald-400"
                    }`}>
                      {roleLabel(user.role, isArabic)}
                    </span>
                    <span className={`text-[9px] px-2 py-0.5 rounded font-bold uppercase ${
                      user.isActive ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
                    }`}>
                      {isArabic ? (user.isActive ? "نشط" : "موقوف") : (user.isActive ? "Actif" : "Bloqué")}
                    </span>
                  </div>
                  <p className="text-[10px] text-gray-600 mt-0.5 font-mono">
                    {units.find((u) => u.code === user.unitId)?.nameAr || user.unitId}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {isSuper && (
                    <button
                      onClick={() => handleDeleteUser(user)}
                      disabled={busy}
                      className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-950/20 rounded-lg cursor-pointer transition-colors"
                      title={isArabic ? "حذف الحساب" : "Supprimer le compte"}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => handleToggleUser(user)}
                    disabled={busy}
                    className="p-1.5 text-gray-400 hover:text-emerald-400 hover:bg-emerald-950/20 rounded-lg cursor-pointer transition-colors"
                    title={isArabic ? "تفعيل / إيقاف" : "Activer / Bloquer"}
                  >
                    <Lock
                      className={`h-3.5 w-3.5 ${!user.isActive ? "text-red-400" : ""}`}
                    />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}