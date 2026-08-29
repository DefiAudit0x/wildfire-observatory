import { useState, useEffect, useCallback } from "react";
import { ClipboardList, Plus, Trash2, Save, ChevronLeft, ChevronRight, CalendarDays, UserPlus, X, Wrench, AlertTriangle, LogOut, RefreshCw, Building2, ShieldCheck, Copy } from "lucide-react";
import { Language } from "../types";
import ConfirmDialog from "./ui/ConfirmDialog";

interface StaffUser {
  agentId: string;
  name: string;
  role: string;
  unitId: string;
  isActive: boolean;
}

interface Personnel {
  agentId: string;
  name: string;
  rank?: string;
}

interface Post {
  id: string;
  labelAr: string;
  labelEn?: string;
  vehicle?: string;
  status: "active" | "standby" | "maintenance";
  personnel: Personnel[];
}

interface RosterDay {
  unitId: string;
  date: string;
  posts: Post[];
  saved: boolean;
}

interface RosterBoardProps {
  lang: Language;
}

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDate(iso: string, isArabic: boolean): string {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString(isArabic ? "ar-DZ" : "fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

export default function RosterBoard({ lang }: RosterBoardProps) {
  const isArabic = lang === "ar";
  const [date, setDate] = useState(todayISO());
  const [roster, setRoster] = useState<RosterDay | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [session, setSession] = useState<{ authenticated: boolean; role: string | null; unitId: string | null; name: string | null }>({
    authenticated: false, role: null, unitId: null, name: null,
  });
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [newPost, setNewPost] = useState({ labelAr: "", vehicle: "" });
  const [confirmAction, setConfirmAction] = useState<null | { kind: "copy"; target: string } | { kind: "removePost"; postId: string }>(null);

  const isWritable = session.authenticated && (session.role === "commander" || session.role === "superadmin" || session.role === "admin");

  const probeSession = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/session", { credentials: "same-origin" });
      if (res.ok) {
        const data = await res.json();
        setSession({
          authenticated: true,
          role: data.user?.role || null,
          unitId: data.user?.unitId || null,
          name: data.user?.name || null,
        });
      } else {
        setSession({ authenticated: false, role: null, unitId: null, name: null });
      }
    } catch {
      setSession({ authenticated: false, role: null, unitId: null, name: null });
    }
  }, []);

  useEffect(() => {
    probeSession();
  }, [probeSession]);

  const fetchRoster = useCallback(async () => {
    setLoading(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/roster/${date}`, { credentials: "same-origin" });
      const data = await res.json();
      if (res.ok) {
        setRoster(data);
      } else if (res.status === 401) {
        setSession((s) => ({ ...s, authenticated: false }));
      } else {
        setRoster({ unitId: "", date, posts: [], saved: false });
      }
    } catch {
      setMsg(isArabic ? "تعذر تحميل الجدول." : "Erreur de chargement.");
    } finally {
      setLoading(false);
    }
  }, [date, isArabic]);

  useEffect(() => {
    if (session.authenticated) {
      fetchRoster();
    }
  }, [session.authenticated, fetchRoster]);

  const fetchStaff = useCallback(async () => {
    try {
      const res = await fetch("/api/users", { credentials: "same-origin" });
      if (res.ok) {
        const data = await res.json();
        setStaff(Array.isArray(data.users) ? data.users.filter((u: any) => u.isActive) : []);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (isWritable) fetchStaff();
  }, [isWritable, fetchStaff]);

  const saveRoster = async () => {
    if (!roster) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/roster/${date}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ posts: roster.posts }),
      });
      const data = await res.json();
      if (res.ok) {
        setRoster(data);
        setMsg(isArabic ? "✓ تم حفظ جدول المناوبة." : "✓ Tableau de garde enregistré.");
      } else {
        setMsg(isArabic ? (data.error || "فشل الحفظ") : (data.error || "Échec de l'enregistrement"));
        await fetchRoster();
      }
    } catch {
      setMsg(isArabic ? "تعذر حفظ الجدول." : "Erreur d'enregistrement.");
      await fetchRoster();
    } finally {
      setSaving(false);
    }
  };

  const doCopyToNextDay = async (target: string) => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/roster/${date}/copy-to/${target}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
      });
      const data = await res.json();
      if (res.status === 201) {
        setMsg(isArabic ? `✓ نُسخ الجدول إلى ${target}.` : `✓ Copié vers ${target}.`);
        setDate(target);
      } else {
        setMsg(isArabic ? (data.error || "فشل النسخ") : (data.error || "Échec de la copie"));
      }
    } catch {
      setMsg(isArabic ? "تعذر النسخ." : "Erreur de copie.");
    } finally {
      setSaving(false);
    }
  };

  const copyToNextDay = () => {
    if (!roster || roster.posts.length === 0) return;
    setConfirmAction({ kind: "copy", target: shiftDate(date, 1) });
  };

  const addPost = async () => {
    if (!newPost.labelAr.trim()) {
      setMsg(isArabic ? "أدخل اسم المنصب." : "Entrez le nom du poste.");
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/roster/${date}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          labelAr: newPost.labelAr.trim(),
          vehicle: newPost.vehicle.trim() || undefined,
          status: "active",
          personnel: [],
        }),
      });
      const data = await res.json();
      if (res.ok || res.status === 201) {
        setNewPost({ labelAr: "", vehicle: "" });
        await fetchRoster();
      } else {
        setMsg(isArabic ? (data.error || "فشل إضافة المنصب") : (data.error || "Échec d'ajout"));
      }
    } catch {
      setMsg(isArabic ? "تعذر إضافة المنصب." : "Erreur d'ajout.");
    } finally {
      setSaving(false);
    }
  };

  const removePost = (postId: string) => {
    setConfirmAction({ kind: "removePost", postId });
  };

  const doRemovePost = (postId: string) => {
    if (!roster) return;
    const updated = { ...roster, posts: roster.posts.filter((p) => p.id !== postId) };
    setRoster(updated);
    setMsg(isArabic ? "تمت إزالة المنصب — اضغط حفظ لتأكيد التغيير." : "Poste retiré — cliquez Enregistrer pour confirmer.");
  };

  const addPersonnel = (postId: string, agentId: string) => {
    if (!roster) return;
    const agent = staff.find((s) => s.agentId === agentId);
    if (!agent) return;
    const exists = roster.posts.some(
      (p) => p.id !== postId && p.personnel.some((x) => x.agentId === agentId)
    );
    if (exists) {
      setMsg(isArabic ? "هذا المناوب موزع في منصب آخر اليوم." : "Cet agent est déjà affecté à un autre poste.");
      return;
    }
    const updated = {
      ...roster,
      posts: roster.posts.map((p) =>
        p.id === postId
          ? { ...p, personnel: [...p.personnel, { agentId: agent.agentId, name: agent.name }] }
          : p
      ),
    };
    setRoster(updated);
  };

  const removePersonnel = (postId: string, agentId: string) => {
    if (!roster) return;
    const updated = {
      ...roster,
      posts: roster.posts.map((p) =>
        p.id === postId ? { ...p, personnel: p.personnel.filter((x) => x.agentId !== agentId) } : p
      ),
    };
    setRoster(updated);
  };

  const updatePersonnel = (postId: string, agentId: string, field: "name" | "rank", value: string) => {
    if (!roster) return;
    setRoster((r) => ({
      ...r!,
      posts: r!.posts.map((p) =>
        p.id === postId
          ? {
              ...p,
              personnel: p.personnel.map((x) => (x.agentId === agentId ? { ...x, [field]: value } : x)),
            }
          : p
      ),
    }));
  };

  const setPostStatus = (postId: string, status: Post["status"]) => {
    if (!roster) return;
    const updated = {
      ...roster,
      posts: roster.posts.map((p) => (p.id === postId ? { ...p, status } : p)),
    };
    setRoster(updated);
  };

  const handleLogout = () => {
    fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
    setSession({ authenticated: false, role: null, unitId: null, name: null });
    setRoster(null);
  };

  if (!session.authenticated) {
    return (
      <div className="max-w-md mx-auto my-12 bg-zinc-950/80 border border-white/5 rounded-2xl p-8 shadow-[0_10px_50px_rgba(0,0,0,0.8)] text-center space-y-6">
        <div className="mx-auto w-16 h-16 bg-sky-600/10 border border-sky-500/20 rounded-2xl flex items-center justify-center text-sky-400">
          <ClipboardList className="h-8 w-8" />
        </div>
        <div>
          <h2 className="text-xl font-extrabold tracking-tight text-slate-100">
            {isArabic ? "جدول مناوبة الوحدة" : "Tableau de Garde"}
          </h2>
          <p className="text-xs text-gray-400 mt-1.5 leading-normal">
            {isArabic
              ? "يتطلب هذا القسم جلسة كادر (قائد وحدة أو مشرف). سجّل الدخول من قسم «الكادر والوحدات» في لوحة المشرف، أو اطلب إنشاء حسابك من قائد وحدتك."
              : "Cette section nécessite une session du personnel (chef d'unité ou superviseur)."}
          </p>
        </div>
        <div className="flex items-center justify-center gap-2 text-[10px] text-gray-600 font-mono">
          <ShieldCheck className="h-3.5 w-3.5 text-sky-500" />
          <span>{isArabic ? "صلاحيات: القراءة لجميع الكادر، التعديل للقادة والمشرفين" : "Lecture: tous · Écriture: chefs & superviseurs"}</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-5 w-full animate-fade-in">
      {/* Header */}
      <div className="bg-zinc-900/50 border border-white/5 p-5 rounded-2xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 bg-sky-600/10 border border-sky-500/20 rounded-xl flex items-center justify-center text-sky-400">
            <ClipboardList className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-lg font-black text-slate-100 flex items-center gap-2 flex-wrap">
              {isArabic ? "جدول مناوبة الوحدة" : "Tableau de Garde"}
              {session.unitId && (
                <span className="bg-sky-700/20 text-sky-300 border border-sky-500/20 text-[9px] font-bold px-2 py-0.5 rounded-full uppercase font-mono">
                  {session.unitId}
                </span>
              )}
            </h2>
            <p className="text-xs text-gray-400 mt-1">
              {session.name ? <span className="font-bold text-slate-300">{session.name}</span> : null}
              {session.role ? <span className="text-slate-400"> · {session.role}</span> : null}
              {isWritable
                ? isArabic ? " — وضع التعديل مفعّل" : " — mode édition"
                : isArabic ? " — وضع القراءة فقط" : " — lecture seule"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2.5 self-end md:self-auto">
          <button
            onClick={() => { setDate(todayISO()); }}
            className="px-3 py-2 bg-black/40 hover:bg-zinc-800 text-gray-300 rounded-xl border border-white/5 text-xs font-bold flex items-center gap-1.5 cursor-pointer transition-colors"
          >
            <CalendarDays className="h-3.5 w-3.5" />
            <span>{isArabic ? "اليوم" : "Aujourd'hui"}</span>
          </button>
          <button
            onClick={probeSession}
            className="p-2.5 bg-black/40 hover:bg-zinc-800 text-gray-400 hover:text-white rounded-xl border border-white/5 transition-colors cursor-pointer"
            title={isArabic ? "تحديث الجلسة" : "Rafraîchir"}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            onClick={handleLogout}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-black transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span>{isArabic ? "خروج" : "Déconnexion"}</span>
          </button>
        </div>
      </div>

      {/* Date navigation */}
      <div className="flex items-center justify-between bg-zinc-900/40 border border-white/5 rounded-xl px-3 py-2.5">
        <button
          onClick={() => setDate((d) => shiftDate(d, -1))}
          className="p-2 bg-black/40 hover:bg-zinc-800 text-gray-400 hover:text-white rounded-lg border border-white/5 cursor-pointer transition-colors"
          title={isArabic ? "اليوم السابق" : "Jour précédent"}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="text-center">
          <p className="text-sm font-black text-slate-100">{formatDate(date, isArabic)}</p>
          <p className="text-[10px] text-gray-500 font-mono">{date}</p>
        </div>
        <button
          onClick={() => setDate((d) => shiftDate(d, 1))}
          className="p-2 bg-black/40 hover:bg-zinc-800 text-gray-400 hover:text-white rounded-lg border border-white/5 cursor-pointer transition-colors"
          title={isArabic ? "اليوم التالي" : "Jour suivant"}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {msg && (
        <p className="text-xs text-slate-300 bg-sky-950/30 border border-sky-500/20 px-3 py-2 rounded-lg flex items-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 text-sky-400 shrink-0" />
          <span>{msg}</span>
        </p>
      )}

      {/* Posts */}
      <div className="space-y-4">
        {!loading && roster && roster.posts.length === 0 && (
          <div className="text-center py-12 text-xs text-gray-500 bg-zinc-900/30 border border-white/5 rounded-2xl">
            {isArabic
              ? "لا توجد مناصب مسجلة لهذا اليوم بعد. أضف أول منصب بالأسفل."
              : "Aucun poste enregistré pour ce jour. Ajoutez le premier poste ci-dessous."}
          </div>
        )}

        {roster?.posts.map((post) => (
          <div key={post.id} className={`bg-zinc-900/40 border rounded-2xl p-4 space-y-3 ${
            post.status === "maintenance" ? "border-amber-500/20 opacity-80" : "border-white/5"
          }`}>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2.5 min-w-0">
                {post.status === "maintenance" ? (
                  <Wrench className="h-4 w-4 text-amber-400 shrink-0" />
                ) : (
                  <Building2 className="h-4 w-4 text-sky-400 shrink-0" />
                )}
                <div className="min-w-0">
                  <h4 className="font-extrabold text-sm text-slate-100 truncate">{post.labelAr}</h4>
                  {post.vehicle && (
                    <p className="text-[10px] text-gray-500 font-mono mt-0.5">{post.vehicle}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {isWritable && (
                  <select
                    value={post.status}
                    onChange={(e) => setPostStatus(post.id, e.target.value as Post["status"])}
                    className="bg-black/50 border border-white/10 rounded-lg px-2 py-1 text-[10px] font-bold text-slate-300 focus:outline-none cursor-pointer"
                  >
                    <option value="active">{isArabic ? "نشط" : "Actif"}</option>
                    <option value="standby">{isArabic ? "احتياط" : "Réserve"}</option>
                    <option value="maintenance">{isArabic ? "صيانة" : "Maintenance"}</option>
                  </select>
                )}
                <span className={`text-[9px] px-2 py-0.5 rounded-full font-bold uppercase ${
                  post.status === "active" ? "bg-emerald-500/10 text-emerald-400"
                  : post.status === "standby" ? "bg-amber-500/10 text-amber-400"
                  : "bg-orange-500/10 text-orange-400"
                }`}>
                  {isArabic
                    ? (post.status === "active" ? "نشط" : post.status === "standby" ? "احتياط" : "صيانة")
                    : post.status}
                </span>
                {isWritable && (
                  <button
                    onClick={() => removePost(post.id)}
                    className="p-1.5 bg-zinc-900 hover:bg-red-600/25 border border-white/5 text-gray-400 hover:text-red-400 rounded-lg cursor-pointer transition-colors"
                    title={isArabic ? "إزالة المنصب" : "Retirer le poste"}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Personnel — MULTIPLE agents per post */}
            <div className="space-y-2">
              {post.personnel.length === 0 && (
                <p className="text-[10px] text-gray-600">
                  {isArabic ? "لا يوجد مناوبون بعد — أضف من الأسفل." : "Aucun agent affecté — ajoutez ci-dessous."}
                </p>
              )}
              {post.personnel.map((person) => (
                <div key={person.agentId} className="flex items-center gap-2 bg-black/40 border border-white/5 rounded-lg px-3 py-2">
                  <div className="w-7 h-7 bg-sky-600/10 border border-sky-500/20 rounded-full flex items-center justify-center text-sky-400 text-xs font-black shrink-0">
                    {person.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <input
                      value={person.name}
                      disabled={!isWritable}
                      onChange={(e) => updatePersonnel(post.id, person.agentId, "name", e.target.value)}
                      className="bg-transparent border border-transparent focus:border-white/10 rounded text-xs font-bold text-slate-100 placeholder:text-gray-600 px-1 py-0.5 focus:outline-none disabled:opacity-100"
                    />
                    <div className="flex items-center gap-2">
                      <input
                        value={person.rank || ""}
                        disabled={!isWritable}
                        onChange={(e) => updatePersonnel(post.id, person.agentId, "rank", e.target.value)}
                        placeholder={isArabic ? "الرتبة/المهمة (سائق، منقذ…)" : "Rang (chauffeur, secouriste…)"}
                        className="bg-transparent border border-transparent focus:border-white/10 rounded text-[10px] text-gray-300 placeholder:text-gray-600 px-1 py-0.5 focus:outline-none disabled:opacity-100 w-full"
                      />
                    </div>
                  </div>
                  {isWritable && (
                    <button
                      onClick={() => removePersonnel(post.id, person.agentId)}
                      className="p-1 text-gray-500 hover:text-red-400 rounded cursor-pointer transition-colors"
                      title={isArabic ? "إزالة" : "Retirer"}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}

              {isWritable && (
                <div className="flex items-center gap-2 bg-sky-950/10 border border-sky-500/10 rounded-lg px-3 py-2">
                  <UserPlus className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                  <select
                    value=""
                    onChange={(e) => { if (e.target.value) addPersonnel(post.id, e.target.value); e.target.value = ""; }}
                    className="flex-1 bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] text-slate-300 focus:outline-none cursor-pointer"
                  >
                    <option value="">{isArabic ? "+ أضف مناوباً إلى هذا المنصب" : "+ Ajouter un agent à ce poste"}</option>
                    {staff.length === 0 ? (
                      <option value="" disabled>
                        {isArabic ? "لا يوجد موظفون متاحون" : "Aucun agent disponible"}
                      </option>
                    ) : (
                      staff.map((s) => (
                        <option key={s.agentId} value={s.agentId}>
                          {s.name} ({s.agentId})
                        </option>
                      ))
                    )}
                  </select>
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Add post (writable only) */}
        {isWritable && (
          <div className="bg-zinc-900/40 border border-dashed border-white/10 rounded-2xl p-4 space-y-3">
            <p className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
              <Plus className="h-3.5 w-3.5 text-sky-400" />
              {isArabic ? "منصب جديد (سيارة، برج مراقبة، نقطة تدخل…)" : "Nouveau poste"}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                value={newPost.labelAr}
                onChange={(e) => setNewPost((f) => ({ ...f, labelAr: e.target.value }))}
                placeholder={isArabic ? "اسم المنصب (مثال: سيارة إسعاف 1)" : "Nom du poste"}
                className="bg-black/50 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-slate-200 placeholder:text-gray-600 focus:ring-1 focus:ring-sky-500/40"
              />
              <input
                value={newPost.vehicle}
                onChange={(e) => setNewPost((f) => ({ ...f, vehicle: e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "") }))}
                maxLength={20}
                placeholder={isArabic ? "الوسيلة / الرمز (VSAV-1)" : "Véhicule / code"}
                className="bg-black/50 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-slate-200 placeholder:text-gray-600 font-mono focus:ring-1 focus:ring-sky-500/40"
              />
            </div>
            <button
              onClick={addPost}
              disabled={saving}
              className="px-4 py-2 bg-sky-700 hover:bg-sky-600 text-white rounded-xl text-xs font-black flex items-center gap-1.5 cursor-pointer transition-colors"
            >
              {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              <span>{isArabic ? "إضافة المنصب" : "Ajouter le poste"}</span>
            </button>
          </div>
        )}
      </div>

      {/* Save bar (writable only) */}
      {isWritable && (
        <div className="sticky bottom-4 bg-zinc-900/90 backdrop-blur border border-white/10 rounded-2xl p-3 flex items-center justify-between gap-3">
          <p className="text-[10px] text-gray-500">
            {isArabic ? "التغييرات تحفظ يدوياً — تأكد من الحفظ قبل مغادرة اليوم." : "Modifications manuelles — enregistrez avant de quitter."}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={copyToNextDay}
              disabled={saving || !roster || roster.posts.length === 0}
              className="px-4 py-2.5 bg-sky-700 hover:bg-sky-600 text-white rounded-xl text-xs font-black flex items-center gap-1.5 cursor-pointer transition-all disabled:opacity-50"
              title={isArabic ? "نسخ مناصب هذا اليوم إلى الغد" : "Copier les postes vers demain"}
            >
              {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{isArabic ? "نسخ إلى الغد" : "Copier demain"}</span>
            </button>
            <button
              onClick={saveRoster}
              disabled={saving || !roster}
              className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-black flex items-center gap-1.5 shadow-lg shadow-emerald-600/20 cursor-pointer transition-all disabled:opacity-50"
            >
              {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              <span>{isArabic ? "حفظ جدول اليوم" : "Enregistrer"}</span>
            </button>
          </div>
        </div>
      )}
    </div>

    <ConfirmDialog
      open={confirmAction !== null}
      lang={lang}
      title={isArabic ? "تأكيد العملية" : "Confirmer"}
      message={
        confirmAction?.kind === "copy"
          ? isArabic
            ? `نسخ مناصب ${date} إلى ${confirmAction.target}؟`
            : `Copier les postes de ${date} vers ${confirmAction.target} ?`
          : isArabic
            ? "إزالة هذا المنصب من الجدول؟ (تظهر بعد الحفظ)"
            : "Retirer ce poste du tableau ? (visible après enregistrement)"
      }
      confirmLabel={isArabic ? "تأكيد" : "Confirmer"}
      danger
      onCancel={() => setConfirmAction(null)}
      onConfirm={() => {
        if (confirmAction?.kind === "copy") {
          void doCopyToNextDay(confirmAction.target);
        } else if (confirmAction?.kind === "removePost") {
          doRemovePost(confirmAction.postId);
        }
        setConfirmAction(null);
      }}
    />
    </>
  );
}