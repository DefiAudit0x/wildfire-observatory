import { useCallback, useMemo, useState } from "react";
import { Language, TabId } from "./types";
import { useSessionProbe } from "./hooks/useSessionProbe";
import { useStaffSession } from "./hooks/useAuth";
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
import { getNearestActiveThreat } from "./utils/threats";

export default function App() {
  const [lang, setLang] = useState<Language>("ar");
  const [activeTab, setActiveTab] = useState<TabId>("home");
  const [mapClickedCoords, setMapClickedCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [showTrappedModal, setShowTrappedModal] = useState(false);

  const isArabic = lang === "ar";
  const privilegedTabVisible = useSessionProbe();
  const { session: staffSession } = useStaffSession();
  const rosterVisible = staffSession.authenticated;

  const { userLocation } = useGeolocation(isArabic);
  const {
    reports,
    satellites,
    wilayas,
    sosCalls,
    notifications,
    loading,
    lastRefreshed,
    lastFetchFailed,
    meshStatus,
    meshNodeCount,
    fetchData,
    handleCreateReport,
    handleConfirmReport,
    handleMarkNotificationRead,
  } = useObservatoryData();

  const { activeAlerts, isMuted, setIsMuted } = useProximityAlerts(reports, userLocation);

  const handleToggleLang = useCallback(() => setLang((prev) => (prev === "ar" ? "fr" : "ar")), []);

  const handleMapClick = useCallback((lat: number, lng: number) => {
    setMapClickedCoords({ lat, lng });
    setSelectedReportId(null);
    // Switch to report tab on mobile so they can see the form filled immediately
    setActiveTab("report");
  }, []);

  const handleSelectReport = useCallback((id: string) => {
    setSelectedReportId(id);
    setMapClickedCoords(null);
    setActiveTab("map");
  }, []);

  // "View the nearest threat on the map": highlights the closest active fire
  // cluster for the user instead of claiming any GPS relocation.
  const handleShowThreatOnMap = useCallback(() => {
    if (activeAlerts.length > 0 && userLocation) {
      setSelectedReportId(activeAlerts[0].id);
      setMapClickedCoords(null);
      setActiveTab("map");
    }
  }, [activeAlerts, userLocation]);

  const handleNavigate = useCallback((tab: TabId) => setActiveTab(tab), []);

  // Nearest active danger to the user, combining clustered citizen reports
  // (non-resolved) and high-confidence satellite hotspots (>=70%) through the
  // single shared threat helper (same definition as the home emergency banner).
  const distanceToFire = useMemo(() => {
    if (!userLocation) return null;

    const { nearest } = getNearestActiveThreat({
      lat: userLocation.lat,
      lng: userLocation.lng,
      reports,
      satellites,
    });

    return nearest ? Math.round(nearest.distanceKm * 1000) : null;
  }, [userLocation, reports, satellites]);

  return (
    <div className="min-h-screen bg-[#0a0505] text-slate-100 font-sans flex flex-col selection:bg-red-500 selection:text-white" dir={isArabic ? "rtl" : "ltr"}>
      <HeaderBar
        isArabic={isArabic}
        lang={lang}
        notifications={notifications}
        lastRefreshed={lastRefreshed}
        lastFetchFailed={lastFetchFailed}
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
          onShowThreat={handleShowThreatOnMap}
        />
      )}

      <TabBar
        isArabic={isArabic}
        activeTab={activeTab}
        privilegedTabVisible={privilegedTabVisible}
        rosterVisible={rosterVisible}
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