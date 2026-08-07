import { useState, useEffect, useCallback } from "react";
import { BadgeCheck, Plus, Trash2, RefreshCw, ToggleLeft, ToggleRight, Save, X, AlertTriangle, Users, Activity, Ban, TimerOff, Gauge } from "lucide-react";
import { Language } from "../../types";

interface Badge {
  code: string;
  ownerName?: string;
  type?: string;
  wilaya?: string;
  phone?: string;
  isActive?: boolean;
  usedCount?: number;
  maxUses?: number;
  expiresAt?: string;
  createdAt?: string;
}

interface Analytics {
  total: number;
  active: number;
  inactive: number;
  expired: number;
  capReached: number;
  totalUsage: number;
  byType: Record<string, number>;
  byWilaya: Record<string, number>;
  topUsed: { code: string; ownerName?: string; usedCount: number; maxUses?: number }[];
}

interface BadgeManagerProps {
  lang: Language;
  onAuthError: (res: Response) => boolean;
}

interface EditState {
  ownerName: string;
  type: string;
  wilaya: string;
  maxUses: string;
  expiresAt: string;
}

const EMPTY_FORM = { code: "", ownerName: "", type: "volunteer", wilaya: "", phone: "", maxUses: "", expiresAt: "" };

export default function BadgeManager({ lang, onAuthError }: BadgeManagerProps) {
  const isArabic = lang === "ar";
  const [badges, setBadges] = useState<Badge[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditState>({ ownerName: "", type: "", wilaya: "", maxUses: "", expiresAt: "" });

  const apiFetch = async (url: string, method: string, body?: unknown) => {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  };

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [bRes, aRes] = await Promise.all([
        apiFetch("/api/badges", "GET"),
        apiFetch("/api/badges/analytics", "GET"),
      ]);
      if (bRes.ok) {
        const data = await bRes.json();
        setBadges(Array.isArray(data) ? data : []);
      } else if (!onAuthError(bRes)) {
        setMsg(isArabic ? "فشل تحميل البادجات" : "Échec du chargement des badges");
      }
      if (aRes.ok) {
        setAnalytics(await aRes.json());
      }
    } catch (err) {
      console.error("Failed to load badges", err);
    } finally {
      setLoading(false);
    }
  }, [onAuthError, isArabic]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const maxUses = form.maxUses ? parseInt(form.maxUses, 10) : undefined;
    try {
      const res = await apiFetch("/api/badges", "POST", {
        code: form.code.trim(),
        ownerName: form.ownerName.trim(),
        type: form.type.trim(),
        wilaya: form.wilaya.trim(),
        phone: form.phone.trim() || undefined,
        maxUses,
        expiresAt: form.expiresAt || undefined,
      });
      if (res.ok || res.status === 201) {
        setForm(EMPTY_FORM);
        await loadAll();
        setMsg(isArabic ? "✓ تم إنشاء البادج." : "✓ Badge créé.");
      } else if (!onAuthError(res)) {
        const data = await res.json().catch(() => ({}));
        setMsg(isArabic ? (data.error || "فشل الإنشاء") : (data.error || "Échec de la création"));
      }
    } catch {
      setMsg(isArabic ? "خطأ في الاتصال." : "Erreur de connexion.");
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (badge: Badge) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch(`/api/badges/${encodeURIComponent(badge.code)}/toggle`, "POST");
      if (res.ok) {
        await loadAll();
      } else if (!onAuthError(res)) {
        setMsg(isArabic ? "فشل التبديل" : "Échec du changement d'état");
      }
    } catch {
      setMsg(isArabic ? "خطأ في الاتصال." : "Erreur de connexion.");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (badge: Badge) => {
    if (!confirm(isArabic ? `حذف البادج "${badge.code}" نهائياً؟` : `Supprimer le badge "${badge.code}" ?`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch(`/api/badges/${encodeURIComponent(badge.code)}`, "DELETE");
      if (res.ok) {
        await loadAll();
        setMsg(isArabic ? "✓ تم حذف البادج." : "✓ Badge supprimé.");
      } else if (!onAuthError(res)) {
        setMsg(isArabic ? "فشل الحذف" : "Échec de la suppression");
      }
    } catch {
      setMsg(isArabic ? "خطأ في الاتصال." : "Erreur de connexion.");
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (badge: Badge) => {
    setEditingCode(badge.code);
    setEditForm({
      ownerName: badge.ownerName || "",
      type: badge.type || "",
      wilaya: badge.wilaya || "",
      maxUses: badge.maxUses !== undefined ? String(badge.maxUses) : "",
      expiresAt: badge.expiresAt || "",
    });
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingCode) return;
    setBusy(true);
    setMsg(null);
    const maxUses = editForm.maxUses ? parseInt(editForm.maxUses, 10) : undefined;
    try {
      const res = await apiFetch(`/api/badges/${encodeURIComponent(editingCode)}`, "PUT", {
        ownerName: editForm.ownerName.trim(),
        type: editForm.type.trim(),
        wilaya: editForm.wilaya.trim(),
        maxUses,
        expiresAt: editForm.expiresAt || undefined,
      });
      if (res.ok) {
        setEditingCode(null);
        await loadAll();
        setMsg(isArabic ? "✓ تم تحديث البادج." : "✓ Badge mis à jour.");
      } else if (!onAuthError(res)) {
        setMsg(isArabic ? "فشل التحديث" : "Échec de la mise à jour");
      }
    } catch {
      setMsg(isArabic ? "خطأ في الاتصال." : "Erreur de connexion.");
    } finally {
      setBusy(false);
    }
  };

  const isExpired = (b: Badge) => {
    if (!b.expiresAt) return false;
    const t = new Date(b.expiresAt).getTime();
    return Number.isFinite(t) && t <= Date.now();
  };

  const capReached = (b: Badge) =>
    typeof b.maxUses === "number" && b.maxUses > 0 && Number(b.usedCount || 0) >= b.maxUses;

  return (
    <div className="space-y-5 w-full animate-fade-in">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <BadgeCheck className="h-4 w-4 text-amber-400" />
          <h3 className="font-extrabold text-sm text-slate-200">
            {isArabic ? "إدارة رموز الاعتماد (Badge Codes)" : "Gestion des codes Badge"}
          </h3>
          <button
            onClick={loadAll}
            disabled={loading}
            className="p-1.5 bg-black/40 hover:bg-zinc-800 text-gray-400 hover:text-white rounded-lg border border-white/5 transition-colors cursor-pointer"
            title="Refresh"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
        <span className="text-[10px] text-gray-500 font-mono">{badges.length} badges</span>
      </div>

      {/* Analytics cards */}
      {analytics && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: isArabic ? "الإجمالي" : "Total", value: analytics.total, icon: <BadgeCheck className="h-4 w-4" />, cls: "text-slate-300" },
            { label: isArabic ? "نشط" : "Actifs", value: analytics.active, icon: <ToggleRight className="h-4 w-4" />, cls: "text-emerald-400" },
            { label: isArabic ? "معطّل" : "Inactifs", value: analytics.inactive, icon: <Ban className="h-4 w-4" />, cls: "text-red-400" },
            { label: isArabic ? "منتهي" : "Expirés", value: analytics.expired, icon: <TimerOff className="h-4 w-4" />, cls: "text-amber-400" },
            { label: isArabic ? "بلغ السقف" : "Cap atteint", value: analytics.capReached, icon: <Gauge className="h-4 w-4" />, cls: "text-orange-400" },
            { label: isArabic ? "مرات الاستخدام" : "Utilisations", value: analytics.totalUsage, icon: <Activity className="h-4 w-4" />, cls: "text-sky-400" },
          ].map((card) => (
            <div key={card.label} className="bg-zinc-950/40 border border-white/5 p-3.5 rounded-xl space-y-1.5">
              <div className={`flex items-center gap-1.5 text-[10px] text-gray-400`}>
                {card.icon}
                <span className="font-bold uppercase">{card.label}</span>
              </div>
              <p className={`text-xl font-black ${card.cls}`}>{card.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Create form */}
      <form onSubmit={handleCreate} className="bg-zinc-900/40 border border-white/5 rounded-2xl p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Plus className="h-4 w-4 text-emerald-400" />
          <h4 className="font-extrabold text-xs text-slate-200 uppercase">
            {isArabic ? "إنشاء بادج جديد" : "Nouveau badge"}
          </h4>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <input
            value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
            placeholder={isArabic ? "الرمز (مثال VOL-001)" : "Code (ex: VOL-001)"}
            required
            className="bg-black/50 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder:text-gray-600 font-mono focus:ring-1 focus:ring-emerald-500/40"
          />
          <input
            value={form.ownerName}
            onChange={(e) => setForm((f) => ({ ...f, ownerName: e.target.value }))}
            placeholder={isArabic ? "اسم الحامل" : "Nom du titulaire"}
            required
            className="bg-black/50 border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder:text-gray-600 focus:ring-1 focus:ring-emerald-500/40"
          />
          <select
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
            className="bg-black/50 border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-300 font-bold focus:ring-1 focus:ring-emerald-500/40 focus:outline-none cursor-pointer"
          >
            <option value="volunteer">{isArabic ? "متطوع" : "Volontaire"}</option>
            <option value="official">{isArabic ? "رسمي" : "Officiel"}</option>
          </select>
          <input
            value={form.wilaya}
            onChange={(e) => setForm((f) => ({ ...f, wilaya: e.target.value }))}
            placeholder={isArabic ? "الولاية المقيدة" : "Wilaya"}
            required
            className="bg-black/50 border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder:text-gray-600 focus:ring-1 focus:ring-emerald-500/40"
          />
          <input
            value={form.phone}
            onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            placeholder={isArabic ? "هاتف (اختياري)" : "Téléphone (optionnel)"}
            className="bg-black/50 border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder:text-gray-600 font-mono focus:ring-1 focus:ring-emerald-500/40"
          />
          <input
            value={form.maxUses}
            onChange={(e) => setForm((f) => ({ ...f, maxUses: e.target.value }))}
            type="number"
            min="1"
            placeholder={isArabic ? "سقف الاستخدام" : "Cap d'utilisation"}
            className="bg-black/50 border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder:text-gray-600 font-mono focus:ring-1 focus:ring-emerald-500/40"
          />
          <input
            value={form.expiresAt}
            onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))}
            type="datetime-local"
            placeholder="Expiration"
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
        </div>
      </form>

      {msg && <p className="text-xs text-slate-400 bg-white/5 border border-white/10 px-3 py-2 rounded-lg">{msg}</p>}

      {/* Badge list */}
      <div className="bg-zinc-900/40 border border-white/5 rounded-2xl p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-amber-400" />
          <h4 className="font-extrabold text-xs text-slate-200 uppercase">
            {isArabic ? "البادجات المسجلة" : "Badges enregistrés"}
          </h4>
        </div>

        {badges.length === 0 && !loading ? (
          <p className="text-xs text-gray-600 text-center py-6">
            {isArabic ? "لا توجد بادجات بعد." : "Aucun badge enregistré."}
          </p>
        ) : (
          <div className="space-y-2">
            {badges.map((badge) => {
              const expired = isExpired(badge);
              const capped = capReached(badge);
              const active = badge.isActive === true && !expired && !capped;
              return (
                <div key={badge.code} className="bg-black/40 border border-white/5 rounded-xl px-3.5 py-3 space-y-2.5">
                  {editingCode === badge.code ? (
                    <form onSubmit={handleSaveEdit} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
                      <input
                        value={editForm.ownerName}
                        onChange={(e) => setEditForm((f) => ({ ...f, ownerName: e.target.value }))}
                        placeholder={isArabic ? "اسم الحامل" : "Nom"}
                        className="bg-black/50 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-gray-600 focus:ring-1 focus:ring-amber-500/40"
                      />
                      <select
                        value={editForm.type}
                        onChange={(e) => setEditForm((f) => ({ ...f, type: e.target.value }))}
                        className="bg-black/50 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 font-bold focus:ring-1 focus:ring-amber-500/40 focus:outline-none cursor-pointer"
                      >
                        <option value="volunteer">{isArabic ? "متطوع" : "Volontaire"}</option>
                        <option value="official">{isArabic ? "رسمي" : "Officiel"}</option>
                      </select>
                      <input
                        value={editForm.wilaya}
                        onChange={(e) => setEditForm((f) => ({ ...f, wilaya: e.target.value }))}
                        placeholder={isArabic ? "الولاية" : "Wilaya"}
                        className="bg-black/50 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-gray-600 focus:ring-1 focus:ring-amber-500/40"
                      />
                      <input
                        value={editForm.maxUses}
                        onChange={(e) => setEditForm((f) => ({ ...f, maxUses: e.target.value }))}
                        type="number"
                        min="1"
                        placeholder={isArabic ? "سقف الاستخدام" : "Cap"}
                        className="bg-black/50 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-gray-600 font-mono focus:ring-1 focus:ring-amber-500/40"
                      />
                      <input
                        value={editForm.expiresAt}
                        onChange={(e) => setEditForm((f) => ({ ...f, expiresAt: e.target.value }))}
                        type="datetime-local"
                        className="bg-black/50 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 font-mono focus:ring-1 focus:ring-amber-500/40"
                      />
                      <div className="flex items-center gap-1.5 sm:col-span-2 lg:col-span-5">
                        <button type="submit" disabled={busy} className="px-3 py-1.5 bg-emerald-600/15 hover:bg-emerald-600/25 border border-emerald-500/30 text-emerald-400 rounded-lg text-[10px] font-black flex items-center gap-1 cursor-pointer">
                          <Save className="h-3 w-3" /> {isArabic ? "حفظ" : "Sauver"}
                        </button>
                        <button type="button" onClick={() => setEditingCode(null)} className="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-gray-400 rounded-lg text-[10px] font-black flex items-center gap-1 cursor-pointer">
                          <X className="h-3 w-3" /> {isArabic ? "إلغاء" : "Annuler"}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded">{badge.code}</span>
                            <span className="text-xs font-bold text-slate-100">{badge.ownerName || "—"}</span>
                            <span className="text-[9px] px-2 py-0.5 rounded font-bold uppercase bg-sky-500/10 text-sky-400">{badge.type}</span>
                            <span className={`text-[9px] px-2 py-0.5 rounded font-bold uppercase ${
                              active ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
                            }`}>
                              {isArabic ? (active ? "نشط" : "غير نشط") : (active ? "Actif" : "Inactif")}
                            </span>
                            {expired && <span className="text-[9px] px-2 py-0.5 rounded font-bold uppercase bg-amber-500/10 text-amber-400">{isArabic ? "منتهي" : "Expiré"}</span>}
                            {capped && <span className="text-[9px] px-2 py-0.5 rounded font-bold uppercase bg-orange-500/10 text-orange-400">{isArabic ? "سقف مُستنفد" : "Cap épuisé"}</span>}
                          </div>
                          <p className="text-[10px] text-gray-500 mt-1 font-mono truncate">
                            {badge.wilaya} · {isArabic ? "استخدام" : "Usage"}: {badge.usedCount || 0}{badge.maxUses ? `/${badge.maxUses}` : ""}
                            {badge.expiresAt ? ` · ${new Date(badge.expiresAt).toLocaleString()}` : ""}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            onClick={() => startEdit(badge)}
                            disabled={busy}
                            className="p-1.5 text-gray-400 hover:text-amber-400 hover:bg-amber-950/20 rounded-lg cursor-pointer transition-colors"
                            title={isArabic ? "تعديل" : "Modifier"}
                          >
                            <Save className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => handleToggle(badge)}
                            disabled={busy}
                            className="p-1.5 text-gray-400 hover:text-emerald-400 hover:bg-emerald-950/20 rounded-lg cursor-pointer transition-colors"
                            title={isArabic ? "تفعيل / تعطيل" : "Activer / Désactiver"}
                          >
                            {badge.isActive === true ? <ToggleRight className="h-3.5 w-3.5 text-emerald-400" /> : <ToggleLeft className="h-3.5 w-3.5" />}
                          </button>
                          <button
                            onClick={() => handleDelete(badge)}
                            disabled={busy}
                            className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-950/20 rounded-lg cursor-pointer transition-colors"
                            title={isArabic ? "حذف" : "Supprimer"}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                      {!active && (
                        <p className="text-[10px] text-gray-600 flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" />
                          {isArabic
                            ? (expired ? "انتهت صلاحية هذا البادج — لن يُقبل أي بلاغ جديد به."
                              : capped ? "استُنفد سقف الاستخدام — لن يُقبل أي بلاغ جديد به."
                              : "هذا البادج معطّل — لن يُقبل أي بلاغ جديد به.")
                            : (expired ? "Ce badge est expiré — aucun nouveau signalement ne sera accepté."
                              : capped ? "Le cap d'utilisation est épuisé — aucun nouveau signalement ne sera accepté."
                              : "Ce badge est désactivé — aucun nouveau signalement ne sera accepté.")}
                        </p>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Analytics details */}
      {analytics && (analytics.topUsed.length > 0 || Object.keys(analytics.byWilaya).length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {analytics.topUsed.length > 0 && (
            <div className="bg-zinc-900/40 border border-white/5 rounded-2xl p-5 space-y-2">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-sky-400" />
                <h4 className="font-extrabold text-xs text-slate-200 uppercase">
                  {isArabic ? "الأكثر استخداماً" : "Badges les plus utilisés"}
                </h4>
              </div>
              {analytics.topUsed.map((t, i) => (
                <div key={t.code} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="font-mono text-slate-300">{i + 1}. {t.code} <span className="text-gray-500">({t.ownerName || "—"})</span></span>
                  <span className="font-mono text-sky-400 font-bold">{t.usedCount}{t.maxUses ? `/${t.maxUses}` : ""}</span>
                </div>
              ))}
            </div>
          )}
          <div className="bg-zinc-900/40 border border-white/5 rounded-2xl p-5 space-y-2">
            <div className="flex items-center gap-2">
              <BadgeCheck className="h-4 w-4 text-purple-400" />
              <h4 className="font-extrabold text-xs text-slate-200 uppercase">
                {isArabic ? "حسب الولاية" : "Par wilaya"}
              </h4>
            </div>
            {Object.entries(analytics.byWilaya).length === 0 ? (
              <p className="text-xs text-gray-600">{isArabic ? "لا بيانات." : "Aucune donnée."}</p>
            ) : (
              Object.entries(analytics.byWilaya).map(([w, n]) => (
                <div key={w} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-slate-300 truncate">{w}</span>
                  <span className="font-mono text-purple-400 font-bold">{n}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
