import { useCallback, useState } from "react";
import { Language, TabId } from "./types";
import { useSessionProbe } from "./hooks/useSessionProbe";
import { useGeolocation } from "./hooks/useGeolocation";
import { useObservatoryData } from "./hooks/useObservatoryData";
import { useProximityAlerts } from "./hooks/useProximityAlerts";
import HeaderBar from "./components/layout/HeaderBar";
import TabBar from "./components/layout/TabBar";
import ProximityAlertBar from "./components/layout/ProximityAlertBar";
import SosFab from "./components/layout/SosFab";
import AppFooter from "./components/layout/AppFooter";
import MainContent from "./components/layout/MainContent";
import TrappedSOSModal from "./components/TrappedSOSModal";

export default function App() {
  const [lang, setLang] = useState<Language>("ar");
  const [activeTab, setActiveTab] = useState<TabId>("home");
  const [mapClickedCoords, setMapClickedCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [showTrappedModal, setShowTrappedModal] = useState(false);

  const isArabic = lang === "ar";
  const privilegedTabVisible = useSessionProbe();

  const { userLocation } = useGeolocation(isArabic);
  const {
    reports,
    satellites,
    wilayas,
    sosCalls,
    notifications,
    loading,
    lastRefreshed,
    meshStatus,
    meshNodeCount,
    fetchData,
    handleCreateReport,
    handleConfirmReport,
    handleMarkNotificationRead,
  } = useObservatoryData();

  const { activeAlerts, isMuted, setIsMuted, getProximityDistance } = useProximityAlerts(reports, userLocation);

  const handleToggleLang = useCallback(() => setLang((prev) => (prev === "ar" ? "fr" : "ar")), []);

  const handleMapClick = useCallback((lat: number, lng: number) => {
    setMapClickedCoords({ lat, lng });
    // Switch to report tab on mobile so they can see the form filled immediately
    setActiveTab("report");
  }, []);

  const handleSelectReport = useCallback((id: string) => {
    setSelectedReportId(id);
    setActiveTab("map");
  }, []);

  const handleLocate = useCallback(() => {
    if (activeAlerts.length > 0 && userLocation) {
      setSelectedReportId(activeAlerts[0].id);
      setActiveTab("map");
    }
  }, [activeAlerts, userLocation]);

  const handleNavigate = useCallback((tab: TabId) => setActiveTab(tab), []);

  const distanceToFire =
    userLocation && reports.length > 0
      ? reports.reduce((nearest, rep) => {
          const dist = getProximityDistance(userLocation.lat, userLocation.lng, rep.lat, rep.lng);
          return Math.min(nearest, Math.round(dist * 1000));
        }, Infinity)
      : null;

  return (
    <div className="min-h-screen bg-[#0a0505] text-slate-100 font-sans flex flex-col selection:bg-red-500 selection:text-white" dir={isArabic ? "rtl" : "ltr"}>
      <HeaderBar
        isArabic={isArabic}
        lang={lang}
        notifications={notifications}
        lastRefreshed={lastRefreshed}
        loading={loading}
        meshStatus={meshStatus}
        meshNodeCount={meshNodeCount}
        onToggleLang={handleToggleLang}
        onRefresh={fetchData}
        onMarkRead={handleMarkNotificationRead}
      />

      {/* REAL-TIME PROXIMITY DETECTION & NOTIFICATION ALERTS HUD */}
      {activeAlerts.length > 0 && (
        <ProximityAlertBar
          isArabic={isArabic}
          activeAlerts={activeAlerts}
          userLocation={userLocation}
          isMuted={isMuted}
          onToggleMute={() => setIsMuted((prev) => !prev)}
          onLocate={handleLocate}
        />
      )}

      <TabBar
        isArabic={isArabic}
        activeTab={activeTab}
        privilegedTabVisible={privilegedTabVisible}
        onSelectTab={handleNavigate}
      />

      <MainContent
        isArabic={isArabic}
        lang={lang}
        activeTab={activeTab}
        reports={reports}
        satellites={satellites}
        wilayas={wilayas}
        sosCalls={sosCalls}
        userLocation={userLocation}
        mapClickedCoords={mapClickedCoords}
        selectedReportId={selectedReportId}
        privilegedTabVisible={privilegedTabVisible}
        onMapClick={handleMapClick}
        onConfirmReport={handleConfirmReport}
        onCreateReport={handleCreateReport}
        onSelectReport={handleSelectReport}
        onNavigate={handleNavigate}
        onTriggerSOS={() => setShowTrappedModal(true)}
        onRefresh={fetchData}
        onClearMapPin={() => setMapClickedCoords(null)}
      />

      {/* SOS FLOATING ACTION BUTTON */}
      <SosFab isArabic={isArabic} onTrigger={() => setShowTrappedModal(true)} />

      {/* Trapped Person SOS Modal */}
      {showTrappedModal && (
        <TrappedSOSModal
          lang={lang}
          onClose={() => {
            setShowTrappedModal(false);
            fetchData();
          }}
          userLocation={userLocation}
          distanceToFire={distanceToFire}
        />
      )}

      {/* BRAND FOOTER */}
      <AppFooter isArabic={isArabic} />
    </div>
  );
}