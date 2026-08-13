import { lazy, Suspense } from "react";
import { Navigation, MessageSquare } from "lucide-react";
import { Report, SatelliteHotspot, WilayaStatus, TrappedSOS, TabId, Language } from "../../types";
import { GeoPoint } from "../../hooks/useProximityAlerts";
import ReportForm from "../ReportForm";
import StatisticsPanel from "../StatisticsPanel";
import WilayaList from "../WilayaList";
import AICopilot from "../AICopilot";
import SafetyGuides from "../SafetyGuides";
import EvacuationRadar from "../EvacuationRadar";
import VolunteerRegistration from "../VolunteerRegistration";
import SafeEvacuation from "../SafeEvacuation";
import HomeHub from "../HomeHub";
import EmergencyContactsCard from "./EmergencyContactsCard";
import { DatasetHealth, SyncState } from "../../utils/datasetHealth";

const CentralCommand = lazy(() => import("../CentralCommand"));
const InteractiveMap = lazy(() => import("../InteractiveMap"));
const AdminPanel = lazy(() => import("../AdminPanel"));
const RosterBoard = lazy(() => import("../RosterBoard"));

const PanelFallback = ({
  isArabic,
  labelAr = "لوحة القيادة",
  labelFr = "tableau de bord",
}: {
  isArabic: boolean;
  labelAr?: string;
  labelFr?: string;
}) => (
  <div role="status" aria-live="polite" className="col-span-12 py-24 flex items-center justify-center text-sm text-gray-500 font-bold animate-pulse">
    ⏳ {isArabic ? `جارٍ تحميل ${labelAr}...` : `Chargement de ${labelFr}...`}
  </div>
);

interface MainContentProps {
  isArabic: boolean;
  lang: Language;
  activeTab: TabId;
  reports: Report[];
  satellites: SatelliteHotspot[];
  wilayas: WilayaStatus[];
  sosCalls: TrappedSOS[];
  userLocation: GeoPoint | null;
  mapClickedCoords: GeoPoint | null;
  selectedReportId: string | null;
  privilegedTabVisible: boolean;
  syncState: SyncState;
  reportsHealth: DatasetHealth;
  onMapClick: (lat: number, lng: number) => void;
  onConfirmReport: (id: string) => void;
  onCreateReport: (payload: any) => Promise<unknown>;
  onSelectReport: (id: string) => void;
  onNavigate: (tab: TabId) => void;
  onTriggerSOS: () => void;
  onRefresh: () => void;
  onClearMapPin: () => void;
}

export default function MainContent({
  isArabic,
  lang,
  activeTab,
  reports,
  satellites,
  wilayas,
  sosCalls,
  userLocation,
  mapClickedCoords,
  selectedReportId,
  privilegedTabVisible,
  syncState,
  reportsHealth,
  onMapClick,
  onConfirmReport,
  onCreateReport,
  onSelectReport,
  onNavigate,
  onTriggerSOS,
  onRefresh,
  onClearMapPin,
}: MainContentProps) {
  return (
    <main className="flex-1 px-4 py-5 md:px-8 max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* Simple Emergency-First Home Screen */}
      {activeTab === "home" && (
        <div className="col-span-12 animate-fadeIn">
          <HomeHub
            onNavigate={onNavigate}
            onTriggerSOS={onTriggerSOS}
            lang={lang}
            reportsCount={reports.length}
            sosCount={sosCalls.filter((s) => s.status === "active").length}
            reports={reports}
            satellites={satellites}
            userLocation={userLocation}
            showAdminEntries={privilegedTabVisible}
            syncState={syncState}
          />
        </div>
      )}

      {/* Safe Evacuation Radar View */}
      {activeTab === "radar" && (
        <div className="col-span-12">
          <EvacuationRadar reports={reports} userLocation={userLocation} lang={lang} />
        </div>
      )}

      {/* Admin Moderation Panel View */}
      {activeTab === "admin" && (
        <div className="col-span-12">
          <Suspense fallback={<PanelFallback isArabic={isArabic} labelAr="لوحة المشرف" labelFr="espace admin" />}>
            <AdminPanel reports={reports} onRefresh={onRefresh} lang={lang} />
          </Suspense>
        </div>
      )}

      {/* Volunteer Registration full page */}
      {activeTab === "volunteer" && (
        <div className="col-span-12 max-w-2xl mx-auto">
          <VolunteerRegistration lang={lang} />
        </div>
      )}

      {/* Central Command - full-screen command dashboard */}
      {activeTab === "command" && (
        <Suspense fallback={<PanelFallback isArabic={isArabic} labelAr="غرفة القيادة" labelFr="commandement central" />}>
          <CentralCommand reports={reports} satellites={satellites} sosCalls={sosCalls} userLocation={userLocation} lang={lang} onRefresh={onRefresh} />
        </Suspense>
      )}

      {/* Staff duty roster */}
      {activeTab === "roster" && (
        <div className="col-span-12 animate-fadeIn">
          <Suspense fallback={<PanelFallback isArabic={isArabic} labelAr="جدول المناوبة" labelFr="tableau de garde" />}>
            <RosterBoard lang={lang} />
          </Suspense>
        </div>
      )}

      {/* Safe Evacuation View */}
      {activeTab === "evac" && (
        <div className="col-span-12 animate-fadeIn">
          <SafeEvacuation lang={lang} userLocation={userLocation} />
        </div>
      )}

      {/* Report is a focused full-width workflow, not a sidebar widget. */}
      {activeTab === "report" && (
        <div className="col-span-12 max-w-3xl mx-auto w-full animate-fadeIn">
          <ReportForm
            mapClickedCoords={mapClickedCoords}
            onSubmit={onCreateReport}
            lang={lang}
            reports={reports}
            wilayas={wilayas}
          />
          <EmergencyContactsCard isArabic={isArabic} compact />
        </div>
      )}

      {/* Normal layout columns */}
      {activeTab !== "radar" && activeTab !== "admin" && activeTab !== "volunteer" && activeTab !== "command" && activeTab !== "evac" && activeTab !== "home" && activeTab !== "roster" && activeTab !== "report" && (
        <>
          {/* Live statistics summary cards */}
          {activeTab === "map" && (
            <div className="col-span-12">
              <StatisticsPanel reports={reports} satellites={satellites} wilayas={wilayas} lang={lang} />
            </div>
          )}

          {/* LEFT MAIN PANELS (Leaflet Map, Guidance, Guides) - Spans 8 columns on desktop */}
          <section className={`lg:col-span-8 space-y-6 ${activeTab === "map" || activeTab === "guides" ? "block" : "hidden md:block"}`}>
            {/* Map Box */}
            {activeTab === "map" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h2 className="font-bold text-slate-100 flex items-center gap-1.5 text-base">
                    <Navigation className="h-4 w-4 text-red-500 animate-bounce" />
                    <span>
                      {isArabic
                        ? "الخريطة التفاعلية لرصد حرائق الغابات في شمال إفريقيا"
                        : "Carte interactive de surveillance des feux de forêt en Afrique du Nord"}
                    </span>
                  </h2>
                  {mapClickedCoords && (
                    <button
                      onClick={onClearMapPin}
                      className="text-xs text-red-400 hover:text-red-300 font-bold"
                    >
                      {isArabic ? "إلغاء التثبيت" : "Réinitialiser l'épingle"}
                    </button>
                  )}
                </div>

                <Suspense fallback={<PanelFallback isArabic={isArabic} labelAr="الخريطة" labelFr="la carte" />}>
                  <InteractiveMap
                    reports={reports}
                    satellites={satellites}
                    onMapClick={onMapClick}
                    onConfirmReport={onConfirmReport}
                    selectedReportId={selectedReportId}
                    lang={lang}
                  />
                </Suspense>
              </div>
            )}

            {/* Active Community Reports Feed */}
            {activeTab === "map" && (
              <div className="bg-zinc-900/50 border border-white/5 rounded-xl p-5 shadow-[0_4px_25px_rgba(0,0,0,0.5)]">
                {(reportsHealth.lastSuccess && (!reportsHealth.lastAttemptOk || syncState === "stale" || syncState === "offline")) && (
                  <div role="status" className="mb-3 rounded-lg border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-[10px] font-bold text-amber-300">
                    {isArabic ? "آخر بيانات البلاغات المتاحة قد تكون قديمة — تحقق من وقت آخر مزامنة." : "Les derniers signalements disponibles peuvent être anciens — vérifiez la dernière synchronisation."}
                  </div>
                )}
                <h3 className="font-bold text-base text-slate-100 mb-3 flex items-center gap-2">
                  <MessageSquare className="h-4 w-4 text-orange-500" />
                  <span>{isArabic ? "سجل البلاغات الميدانية الأخيرة" : "Flux des signalements citoyens récents"}</span>
                </h3>

                <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1">
                  {reports.length === 0 ? (
                    <div className="text-center py-8 text-xs text-gray-500">
                      {isArabic ? "لا توجد بلاغات مرسلة حالياً في السجل." : "Aucun signalement dans le flux."}
                    </div>
                  ) : (
                    reports.map((rep) => (
                      <button
                        type="button"
                        key={rep.id}
                        onClick={() => onSelectReport(rep.id)}
                        className={`w-full text-left bg-black/40 hover:bg-black/60 p-3.5 rounded-lg border transition-all cursor-pointer flex flex-col md:flex-row gap-3 items-start md:items-center justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 ${
                          selectedReportId === rep.id ? "border-red-650 bg-red-950/10 shadow-[0_0_15px_rgba(220,38,38,0.15)]" : "border-white/5"
                        }`}
                      >
                        <div className="flex gap-3 items-start">
                          {rep.image && (rep.image.startsWith("data:image/") || rep.image.startsWith("https://")) ? (
                            <img src={rep.image} className="w-16 h-12 object-cover rounded border border-white/5 mt-1" alt={isArabic ? `صورة بلاغ: ${rep.locationName}` : `Photo du signalement : ${rep.locationName}`} referrerPolicy="no-referrer" />
                          ) : (
                            <div className="w-16 h-12 bg-black/40 rounded border border-white/5 flex items-center justify-center text-xs text-slate-500">
                              🔥
                            </div>
                          )}
                          <div>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <h4 className="font-bold text-xs text-slate-200">{rep.locationName}</h4>
                              {rep.reporterType === "official" && (
                                <span className="bg-amber-500/10 border border-amber-500/30 text-amber-400 text-[9px] px-1.5 py-0.5 rounded font-black">
                                  🛡️ {isArabic ? "جهة رسمية" : "Officiel"}
                                </span>
                              )}
                              {rep.reporterType === "volunteer" && (
                                <span className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[9px] px-1.5 py-0.5 rounded font-bold">
                                  💚 {isArabic ? "متطوع" : "Bénévole"}
                                </span>
                              )}
                            </div>
                            <p className="text-[10px] text-gray-400 mt-0.5">{rep.wilaya} | {new Date(rep.timestamp).toLocaleTimeString(isArabic ? "ar-DZ" : "fr-DZ")}</p>
                            <p className="text-[11px] text-gray-300 mt-1 line-clamp-1 italic">{rep.description}</p>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 self-end md:self-auto mt-2 md:mt-0">
                          {rep.clusterSize && rep.clusterSize > 1 && (
                            <span className="bg-orange-500/10 text-orange-400 border border-orange-500/20 text-[9px] px-2 py-0.5 rounded-full font-bold">
                              📍 {isArabic ? `بؤرة مشتركة (${rep.clusterSize})` : `Cluster (${rep.clusterSize})`}
                            </span>
                          )}
                          {rep.aiVerification && (
                            <span className="bg-emerald-950 text-emerald-400 border border-emerald-500/20 text-[9px] px-2 py-0.5 rounded-full font-bold">
                              🤖 {isArabic ? "فحص ذكاء اصطناعي" : "Analyse IA"}
                            </span>
                          )}
                          <span className="bg-black/50 text-gray-400 border border-white/5 text-[10px] px-2 py-0.5 rounded font-mono font-semibold">
                            {isArabic ? `تأكيدات: ${rep.consensusCount}` : `Confirmations: ${rep.consensusCount}`}
                          </span>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* Guides Section */}
            {activeTab === "guides" && (
              <div>
                <SafetyGuides lang={lang} />
              </div>
            )}
          </section>

          {/* RIGHT SIDEBAR PANEL */}
          <section className="lg:col-span-4 space-y-6">
            {/* Wilayas Statuses List: desktop sidebar only — keeps the mobile
                map tab focused on the map instead of piling up four layers */}
            <div className="hidden md:block">
              <WilayaList wilayas={wilayas} lang={lang} />
            </div>

            {/* AI Copilot Responder tab on mobile / Sidebar on desktop */}
            <div className={`${activeTab === "copilot" ? "block" : "hidden md:block"}`}>
              <AICopilot mapClickedCoords={mapClickedCoords} lang={lang} />
            </div>

            {/* Printable Emergency Call Card */}
            <EmergencyContactsCard isArabic={isArabic} />
          </section>
        </>
      )}
    </main>
  );
}