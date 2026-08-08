import { useState, useEffect, useCallback } from "react";
import { MapPin, Plus, Trash2, RefreshCw, ShieldCheck, AlertTriangle, Save, Search } from "lucide-react";
import { Language } from "../../types";
import ConfirmDialog from "../ui/ConfirmDialog";
import ToastStack from "../ui/ToastStack";
import useToasts from "../../hooks/useToasts";

interface SafeZoneItem {
  id: string;
  nameAr: string;
  nameFr: string;
  lat: number;
  lng: number;
  capacity: number;
  hasMedical: boolean;
  isActive?: boolean;
}

interface SafeZonesManagerProps {
  lang: Language;
  onAuthError: (res: Response) => boolean;
}

export default function SafeZonesManager({ lang, onAuthError }: SafeZonesManagerProps) {
  const isArabic = lang === "ar";
  const [zones, setZones] = useState<SafeZoneItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({
    nameAr: "",
    nameFr: "",
    lat: "",
    lng: "",
    capacity: "1000",
    hasMedical: false,
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const { toasts, push } = useToasts();

  const fetchZones = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/safezones");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) setZones(data);
      }
    } catch (err) {
      console.error("Failed to load safe zones", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchZones();
  }, [fetchZones]);

  const apiFetch = async (url: string, method: string, body?: unknown) => {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "same-origin",
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  };

  const handleAddZone = async (e: React.FormEvent) => {
    e.preventDefault();
    const lat = parseFloat(form.lat);
    const lng = parseFloat(form.lng);
    const capacity = parseInt(form.capacity, 10);
    if (isNaN(lat) || isNaN(lng) || !form.nameAr.trim() || !form.nameFr.trim() || isNaN(capacity) || capacity <= 0) {
      setMsg(isArabic ? "تحقق من تعبئة جميع الحقول بقيم صحيحة." : "Vérifiez que tous les champs sont valides.");
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const res = await apiFetch("/api/safezones", "POST", {
        nameAr: form.nameAr.trim(),
        nameFr: form.nameFr.trim(),
        lat,
        lng,
        capacity,
        hasMedical: form.hasMedical,
        isActive: true,
      });
      if (res.ok) {
        setForm({ nameAr: "", nameFr: "", lat: "", lng: "", capacity: "1000", hasMedical: false });
        fetchZones();
        push(isArabic ? "تمت إضافة المركز الآمن بنجاح" : "Centre sécurisé ajouté");
      } else if (!onAuthError(res)) {
        setMsg(isArabic ? "فشل إضافة المركز." : "Échec de l'ajout.");
      }
    } catch (err) {
      console.error(err);
      setMsg(isArabic ? "خطأ في الاتصال." : "Erreur de connexion.");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (zone: SafeZoneItem) => {
    try {
      const res = await apiFetch(`/api/safezones/${zone.id}`, "PUT", {
        nameAr: zone.nameAr,
        nameFr: zone.nameFr,
        lat: zone.lat,
        lng: zone.lng,
        capacity: zone.capacity,
        hasMedical: zone.hasMedical,
        isActive: !zone.isActive,
      });
      if (res.ok) fetchZones();
      else onAuthError(res);
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteZone = async (id: string) => {
    try {
      const res = await apiFetch(`/api/safezones/${id}`, "DELETE");
      if (res.ok) {
        fetchZones();
        push(isArabic ? "تم حذف المركز الآمن" : "Centre sécurisé supprimé");
      } else onAuthError(res);
    } catch (err) {
      console.error(err);
    }
  };

  const filteredZones = zones.filter((z) => {
    const matchesSearch =
      !searchQuery.trim() ||
      z.nameAr.toLowerCase().includes(searchQuery.toLowerCase()) ||
      z.nameFr.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "active" && z.isActive !== false) ||
      (statusFilter === "inactive" && z.isActive === false);
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="space-y-4">
      {/* Add Zone Form */}
      <form onSubmit={handleAddZone} className="bg-zinc-900/40 border border-white/5 rounded-2xl p-5 shadow-lg space-y-3">
        <h3 className="font-extrabold text-sm text-slate-200 flex items-center gap-2">
          <Plus className="h-4 w-4 text-emerald-400" />
          {isArabic ? "إضافة مركز آمن جديد" : "Ajouter un centre sécurisé"}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input
            value={form.nameAr}
            onChange={(e) => setForm({ ...form, nameAr: e.target.value })}
            placeholder={isArabic ? "الاسم بالعربية *" : "Nom (arabe) *"}
            className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
          />
          <input
            value={form.nameFr}
            onChange={(e) => setForm({ ...form, nameFr: e.target.value })}
            placeholder={isArabic ? "الاسم بالفرنسية *" : "Nom (français) *"}
            dir="ltr"
            className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
          />
          <input
            value={form.lat}
            onChange={(e) => setForm({ ...form, lat: e.target.value })}
            placeholder="Latitude * (ex: 36.5058)"
            dir="ltr"
            className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
          />
          <input
            value={form.lng}
            onChange={(e) => setForm({ ...form, lng: e.target.value })}
            placeholder="Longitude * (ex: 2.8266)"
            dir="ltr"
            className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
          />
          <input
            value={form.capacity}
            onChange={(e) => setForm({ ...form, capacity: e.target.value })}
            type="number"
            min="1"
            placeholder={isArabic ? "الاستيعاب (شخص)" : "Capacité (pers)"}
            dir="ltr"
            className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
          />
          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={form.hasMedical}
              onChange={(e) => setForm({ ...form, hasMedical: e.target.checked })}
              className="accent-emerald-500"
            />
            {isArabic ? "يوجد نقطة طبية" : "Point médical disponible"}
          </label>
        </div>
        {msg && (
          <p className="text-xs font-bold text-amber-400 flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" />
            {msg}
          </p>
        )}
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 bg-emerald-600/15 hover:bg-emerald-600/25 border border-emerald-500/20 text-emerald-400 rounded-xl text-xs font-black flex items-center gap-1.5 cursor-pointer transition-all disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {saving ? (isArabic ? "جارٍ الحفظ..." : "Enregistrement...") : (isArabic ? "حفظ المركز" : "Enregistrer")}
        </button>
      </form>

      {/* Zones List */}
      <div className="bg-zinc-900/40 border border-white/5 rounded-2xl p-5 shadow-lg space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="font-extrabold text-sm text-slate-200 flex items-center gap-2">
            <MapPin className="h-4 w-4 text-sky-400" />
            {isArabic ? "المراكز الآمنة المسجلة" : "Centres sécurisés enregistrés"}
          </h3>
          <button
            onClick={fetchZones}
            disabled={loading}
            className="p-1.5 bg-zinc-900 hover:bg-zinc-800 border border-white/10 rounded-lg text-slate-300 cursor-pointer transition-all"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={isArabic ? "ابحث عن مركز بالاسم..." : "Rechercher un centre..."}
              className="w-full bg-black/50 border border-white/10 rounded-lg py-2 pl-9 pr-3 text-xs text-slate-200 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-sky-500/40"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as "all" | "active" | "inactive")}
            className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-300 font-bold focus:ring-1 focus:ring-sky-500/40 focus:outline-none cursor-pointer"
          >
            <option value="all">{isArabic ? "كل الحالات" : "Tous"}</option>
            <option value="active">{isArabic ? "نشط" : "Actif"}</option>
            <option value="inactive">{isArabic ? "معطل" : "Inactif"}</option>
          </select>
        </div>

        <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
          {filteredZones.length === 0 ? (
            <div className="text-center py-8 text-xs text-gray-500">
              {isArabic ? "لا توجد مراكز مطابقة." : "Aucun centre correspondant."}
            </div>
          ) : (
            filteredZones.map((z) => (
              <div key={z.id} className={`bg-black/40 border rounded-lg p-3 flex items-center justify-between gap-3 ${z.isActive === false ? "border-white/5 opacity-60" : "border-emerald-500/20"}`}>
                <div className="min-w-0 space-y-0.5">
                  <p className="text-xs font-bold text-slate-200 truncate flex items-center gap-1.5">
                    {z.hasMedical && <ShieldCheck className="h-3 w-3 text-emerald-400 shrink-0" />}
                    {isArabic ? z.nameAr : z.nameFr}
                  </p>
                  <p className="text-[10px] text-gray-500 font-mono">
                    {z.lat.toFixed(4)}, {z.lng.toFixed(4)} • {z.capacity.toLocaleString()} pers
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => handleToggleActive(z)}
                    className={`px-2 py-1 rounded text-[10px] font-bold border transition-all cursor-pointer ${
                      z.isActive === false
                        ? "bg-zinc-900 text-gray-400 border-white/10"
                        : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                    }`}
                  >
                    {z.isActive === false ? (isArabic ? "مُعطّل" : "Inactif") : (isArabic ? "نشط" : "Actif")}
                  </button>
                  <button
                    onClick={() => setConfirmDelete(z.id)}
                    className="p-1.5 bg-zinc-900 hover:bg-red-650/25 border border-white/10 text-gray-400 hover:text-red-400 rounded transition-all cursor-pointer"
                    title={isArabic ? "حذف المركز" : "Supprimer le centre"}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmDelete !== null}
        title={isArabic ? "تأكيد الحذف" : "Confirmation"}
        message={isArabic ? "هل أنت متأكد من حذف هذا المركز الآمن نهائياً؟" : "Supprimer ce centre définitivement ?"}
        confirmLabel={isArabic ? "حذف نهائياً" : "Supprimer"}
        danger
        onConfirm={() => {
          const id = confirmDelete;
          setConfirmDelete(null);
          if (id) handleDeleteZone(id);
        }}
        onCancel={() => setConfirmDelete(null)}
        lang={lang}
      />
      <ToastStack toasts={toasts} />
    </div>
  );
}
