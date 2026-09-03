import { useEffect, useState } from "react";
import { determineWilayaByCoords, OUT_OF_COVERAGE } from "../../utils/geo";
import { geoErrorMessage } from "../useGeolocation";
import { MAGHREB_REGIONS } from "../../data/maghrebRegions";
import { isResolvedWilayaMismatch, type WilayaNote } from "./reportFormShared";

/**
 * ARC-H13 — THE owner of every form field in the report workflow: the two
 * coordinate strings, the descriptive fields, the reporter identity fields,
 * the wilaya selection with its geofence notes, and GPS acquisition.
 *
 * Geofence contract (server owns the truth; the client mirrors it to save the
 * reporter a silent rejection after the fact):
 *  - a fix that resolves to a wilaya AUTO-SELECTS it while the field is empty;
 *  - a selected wilaya that disagrees with the fix surfaces a mismatch warning;
 *  - coordinates outside the monitoring coverage warn when a wilaya is set;
 *  - a fallback-list selection that the authoritative server list does not
 *    contain is cleared WITH its derived note (stale options can never be
 *    submitted).
 */
export interface ReportFieldValues {
  lat: string;
  lng: string;
  locationName: string;
  wilaya: string;
  severity: string;
  description: string;
  reporterName: string;
  reporterPhone: string;
  reporterType: string;
  reporterBadgeCode: string;
}

const FALLBACK_WILAYAS = MAGHREB_REGIONS;

export interface UseReportFieldsParams {
  mapClickedCoords: { lat: number; lng: number } | null;
  wilayas?: { nameAr: string; nameFr: string }[];
  isArabic: boolean;
  setErrorMsg: (message: string | null) => void;
}

export function useReportFields({ mapClickedCoords, wilayas, isArabic, setErrorMsg }: UseReportFieldsParams) {
  // The server owns the wilaya geofence; the static copy only covers the
  // first-load/offline window before the API list arrives.
  const wilayaOptions = wilayas && wilayas.length > 0 ? wilayas : FALLBACK_WILAYAS;
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [locationName, setLocationName] = useState("");
  const [wilaya, setWilaya] = useState("");
  const [severity, setSeverity] = useState("medium");
  const [description, setDescription] = useState("");
  const [reporterName, setReporterName] = useState("");
  const [reporterPhone, setReporterPhone] = useState("");
  const [reporterType, setReporterType] = useState("citizen");
  const [reporterBadgeCode, setReporterBadgeCode] = useState("");
  const [isLocating, setIsLocating] = useState(false);
  const [wilayaNote, setWilayaNote] = useState<WilayaNote | null>(null);

  // Sync clicked coordinates from the parent map component
  useEffect(() => {
    if (mapClickedCoords) {
      setLat(mapClickedCoords.lat.toFixed(6));
      setLng(mapClickedCoords.lng.toFixed(6));
    }
  }, [mapClickedCoords]);

  // v1.0.4 field fix: a confirmed GPS fix or map click now ALSO fills the
  // place-name field automatically (reverse geocoding) — the owner should
  // never re-type what the device already knows. The user's own text is
  // NEVER overwritten: the lookup only fills an EMPTY field.
  // Debounced + aborted so fast coordinate churn (map dragging) does not
  // spam the API; offline/rate-limited failures degrade to typing by hand.
  // W-H6: the lookup used to hit nominatim.openstreetmap.org DIRECTLY from
  // the browser — exact field coordinates leaked to a third party with no
  // consent gate while the project deliberately keeps the location pulse
  // private. It now goes through the same-origin proxy /api/geo/reverse,
  // which is the only egress (server attaches the policy-required UA,
  // caches churn, bounds the coverage).
  useEffect(() => {
    const parsedLat = Number(lat);
    const parsedLng = Number(lng);
    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(`/api/geo/reverse?lat=${parsedLat}&lng=${parsedLng}&lang=ar`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { name?: string; display_name?: string } | null) => {
          if (!data) return;
          const place = (data.name || data.display_name || "").trim();
          if (!place) return;
          setLocationName((current) => (current.trim() === "" ? place : current));
        })
        .catch(() => {
          /* offline or throttled: typing the place name by hand still works */
        });
    }, 800);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [lat, lng]);

  // Bind the selected region to the coordinates (mirror of the server's
  // geofence): suggest the wilaya on GPS fix, warn on wilaya mismatch so the
  // submission is not silently rejected by the server after the fact.
  useEffect(() => {
    const parsedLat = Number(lat);
    const parsedLng = Number(lng);
    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) {
      setWilayaNote(null);
      return;
    }
    const resolved = determineWilayaByCoords(parsedLat, parsedLng);
    if (resolved === OUT_OF_COVERAGE) {
      if (wilaya) {
        setWilayaNote({
          kind: "outside",
          textAr: "⚠️ الإحداثيات خارج تغطية المنصة — سيرفض الخادم البلاغ.",
          textFr: "⚠️ Coordonnées hors couverture — le serveur rejettera le rapport.",
        });
      } else {
        setWilayaNote(null);
      }
      return;
    }
    const resolvedOption = wilayaOptions.find((w) => `${w.nameAr} (${w.nameFr})` === resolved);
    if (!wilaya && resolvedOption) {
      // The geofence result is authoritative for this coordinate. Selecting it
      // here prevents a visible suggestion from remaining an unsubmitted form
      // value while keeping the user free to choose another matching option.
      setWilaya(`${resolvedOption.nameAr} (${resolvedOption.nameFr})`);
      setWilayaNote({
        kind: "suggest",
        option: `${resolvedOption.nameAr} (${resolvedOption.nameFr})`,
        textAr: `تم اعتماد الولاية تلقائيًا حسب الإحداثيات: ${resolvedOption.nameAr}`,
        textFr: `Wilaya automatiquement confirmée par les coordonnées : ${resolvedOption.nameFr}`,
      });
      return;
    }
    if (wilaya) {
      if (isResolvedWilayaMismatch(wilaya, resolved)) {
        setWilayaNote({
          kind: "mismatch",
          textAr: `⚠️ إحداثياتك تقع في «${resolved.split(" (")[0]}» بينما اخترت ولاية مختلفة — سيرفض الخادم البلاغ ما لم تصحّح الاختيار.`,
          textFr: `⚠️ Vos coordonnées sont dans «${resolved.split(" (")[0]}» mais vous avez choisi une autre wilaya — le serveur rejettera le rapport.`,
        });
        return;
      }
    }
    setWilayaNote(null);
  }, [lat, lng, wilaya, wilayaOptions]);

  // Wilaya reconciliation (audit): while the fallback list is live the user
  // may pick a fallback option that does not exist in the server's
  // authoritative list. When the real list arrives (wilayaOptions identity
  // swap), a stale selection is cleared WITH its derived note — the form can
  // never submit a value the server cannot geofence; the user picks again
  // from the authoritative options.
  useEffect(() => {
    if (!wilayas || wilayas.length === 0 || !wilaya) return;
    if (!wilayaOptions.some((w) => `${w.nameAr} (${w.nameFr})` === wilaya)) {
      setWilaya("");
      setWilayaNote(null);
    }
  }, [wilayas, wilaya, wilayaOptions]);

  // Automated browser-side GPS acquisition
  const handleGetLocation = () => {
    if (!navigator.geolocation) {
      setErrorMsg(geoErrorMessage(undefined, isArabic));
      return;
    }

    setIsLocating(true);
    setErrorMsg(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLat(position.coords.latitude.toFixed(6));
        setLng(position.coords.longitude.toFixed(6));
        setIsLocating(false);
      },
      // Same actionable per-code wording as the rest of the app (permission
      // blocked vs no signal vs timeout — each has a different fix).
      (error) => {
        setIsLocating(false);
        setErrorMsg(geoErrorMessage(error?.code, isArabic));
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  // Reset applied after an accepted submission — wilaya and severity are
  // deliberately KEPT (the reporter is usually working inside one region for
  // the whole shift; ported verbatim from the original field-clearing block).
  const resetForNextReport = () => {
    setLocationName("");
    setDescription("");
    setLat("");
    setLng("");
    setReporterName("");
    setReporterPhone("");
    setReporterBadgeCode("");
    setReporterType("citizen");
  };

  return {
    lat, setLat,
    lng, setLng,
    locationName, setLocationName,
    wilaya, setWilaya,
    severity, setSeverity,
    description, setDescription,
    reporterName, setReporterName,
    reporterPhone, setReporterPhone,
    reporterType, setReporterType,
    reporterBadgeCode, setReporterBadgeCode,
    isLocating,
    wilayaOptions,
    wilayaNote, setWilayaNote,
    handleGetLocation,
    resetForNextReport,
    values: {
      lat, lng, locationName, wilaya, severity, description,
      reporterName, reporterPhone, reporterType, reporterBadgeCode,
    } as ReportFieldValues,
  };
}
