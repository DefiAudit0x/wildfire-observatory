import { describe, it, expect } from "vitest";
import {
  validateDataset,
  DatasetValidationError,
  isValidReport,
  REPORT_STATUSES,
  REPORT_SEVERITIES,
} from "../src/utils/datasetValidators.js";

const validReport = {
  id: "r1",
  lat: 36.8,
  lng: 7.6,
  locationName: "غابة",
  wilaya: "الطارف",
  description: "دخان كثيف يتصاعد",
  severity: "high",
  status: "pending",
  timestamp: "2026-08-10T10:00:00Z",
  consensusCount: 5,
};
const validSatellite = {
  id: "s1",
  lat: 36.8,
  lng: 7.6,
  brightness: 340.5,
  confidence: 90,
  scanTime: "2026-08-10T10:00:00Z",
  satellite: "VIIRS",
  wilaya: "الطارف",
};
const validWilaya = {
  nameAr: "الطارف",
  nameFr: "El Tarf",
  activeFires: 2,
  satelliteHotspots: 3,
  severity: "high",
  evacuationRecommended: true,
  emergencyPhone: "1021",
};
const validSos = {
  id: "sos1",
  lat: 36.8,
  lng: 7.6,
  status: "active",
  timestamp: "2026-08-10T10:00:00Z",
};
const validNotification = {
  id: "n1",
  deviceId: "dev-1",
  titleAr: "أ",
  titleFr: "a",
  bodyAr: "ب",
  bodyFr: "b",
  type: "warning",
  timestamp: "2026-08-10T10:00:00Z",
  read: true,
};

describe("validateDataset", () => {
  it("accepts a well-formed array for every dataset", () => {
    expect(validateDataset("reports", [validReport])).toHaveLength(1);
    expect(validateDataset("satellites", [validSatellite])).toHaveLength(1);
    expect(validateDataset("wilayas", [validWilaya])).toHaveLength(1);
    expect(validateDataset("sos", [validSos])).toHaveLength(1);
    expect(validateDataset("notifications", [validNotification])).toHaveLength(1);
  });

  it("accepts an empty array (a healthy observatory with no data)", () => {
    for (const key of ["reports", "satellites", "wilayas", "sos", "notifications"] as const) {
      expect(validateDataset(key, [])).toEqual([]);
    }
  });

  it("fails on a non-array payload no matter how valid the JSON is, with an explicit reason", () => {
    for (const key of ["reports", "satellites", "wilayas", "sos", "notifications"] as const) {
      try {
        validateDataset(key, { error: "temporary malformed response" });
        throw new Error("expected a DatasetValidationError");
      } catch (err) {
        expect(err).toBeInstanceOf(DatasetValidationError);
        expect((err as DatasetValidationError).reason).toBe("not-array");
      }
    }
  });

  it("fails the WHOLE dataset when any single item is malformed, with the item reason", () => {
    expect(() => validateDataset("reports", [validReport, { id: 42, lat: "x" }])).toThrow(
      DatasetValidationError
    );
    expect(() => validateDataset("satellites", [validSatellite, {}])).toThrow(DatasetValidationError);
    expect(() => validateDataset("sos", [validSos, { id: "", lat: NaN, lng: 0 }])).toThrow(
      DatasetValidationError
    );
    expect(() => validateDataset("wilayas", [validWilaya, { nameAr: "" }])).toThrow(
      DatasetValidationError
    );
    expect(() => validateDataset("notifications", [validNotification, { titleFr: 1 }])).toThrow(
      DatasetValidationError
    );
    try {
      validateDataset("reports", [validReport, { id: "x" }]);
    } catch (err) {
      expect((err as DatasetValidationError).reason).toBe("malformed-item");
    }
  });

  it("rejects coordinates outside the physical bounds (999/-999 are finite, not geography)", () => {
    const base = { ...validReport };
    expect(() => validateDataset("reports", [{ ...base, lat: 91 }])).toThrow(DatasetValidationError);
    expect(() => validateDataset("reports", [{ ...base, lat: -91 }])).toThrow(DatasetValidationError);
    expect(() => validateDataset("reports", [{ ...base, lng: 181 }])).toThrow(DatasetValidationError);
    expect(() => validateDataset("reports", [{ ...base, lng: -181 }])).toThrow(DatasetValidationError);
    expect(() => validateDataset("reports", [{ ...base, lat: 999, lng: -999 }])).toThrow(
      DatasetValidationError
    );
    expect(() => validateDataset("sos", [{ ...validSos, lat: 200 }])).toThrow(DatasetValidationError);
    expect(() => validateDataset("satellites", [{ ...validSatellite, lng: -300 }])).toThrow(
      DatasetValidationError
    );
  });

  it("accepts the exact bound values and rejects non-finite coordinates", () => {
    expect(validateDataset("reports", [{ ...validReport, lat: 90, lng: -180 }])).toHaveLength(1);
    expect(validateDataset("reports", [{ ...validReport, lat: -90, lng: 180 }])).toHaveLength(1);
    expect(() => validateDataset("reports", [{ ...validReport, lat: Number.NaN }])).toThrow(
      DatasetValidationError
    );
    expect(() => validateDataset("reports", [{ ...validReport, lng: Number.POSITIVE_INFINITY }])).toThrow(
      DatasetValidationError
    );
  });

  it("rejects reports whose status/severity are not part of the contract", () => {
    expect(() => validateDataset("reports", [{ ...validReport, status: "banana" }])).toThrow(
      DatasetValidationError
    );
    expect(() => validateDataset("reports", [{ ...validReport, severity: "extreme" }])).toThrow(
      DatasetValidationError
    );
    expect(() => validateDataset("reports", [{ ...validReport, consensusCount: undefined }])).toThrow(
      DatasetValidationError
    );
    expect(() => validateDataset("reports", [{ ...validReport, timestamp: "" }])).toThrow(
      DatasetValidationError
    );
  });

  it("rejects an SOS without a status (it could never be counted as active)", () => {
    const { status: _status, ...stateless } = validSos;
    expect(() => validateDataset("sos", [stateless])).toThrow(DatasetValidationError);
    expect(validateDataset("sos", [{ ...validSos, status: "resolved" }])).toHaveLength(1);
  });

  it("rejects satellites missing the fields that define a hotspot", () => {
    expect(() => validateDataset("satellites", [{ ...validSatellite, confidence: undefined }])).toThrow(
      DatasetValidationError
    );
    expect(() => validateDataset("satellites", [{ ...validSatellite, confidence: 101 }])).toThrow(
      DatasetValidationError
    );
    expect(() => validateDataset("satellites", [{ ...validSatellite, satellite: "NOAA" }])).toThrow(
      DatasetValidationError
    );
    expect(() => validateDataset("satellites", [{ ...validSatellite, scanTime: "" }])).toThrow(
      DatasetValidationError
    );
  });

  it("rejects wilayas missing the operational contract fields", () => {
    expect(() => validateDataset("wilayas", [{ nameAr: "x", nameFr: "y" }])).toThrow(
      DatasetValidationError
    );
    expect(() => validateDataset("wilayas", [{ ...validWilaya, severity: "burning" }])).toThrow(
      DatasetValidationError
    );
    expect(() => validateDataset("wilayas", [{ ...validWilaya, evacuationRecommended: "yes" }])).toThrow(
      DatasetValidationError
    );
  });

  it("rejects notifications missing body/type/timestamp", () => {
    expect(() => validateDataset("notifications", [{ ...validNotification, bodyAr: "" }])).toThrow(
      DatasetValidationError
    );
    expect(() => validateDataset("notifications", [{ ...validNotification, type: "urgent" }])).toThrow(
      DatasetValidationError
    );
    expect(() => validateDataset("notifications", [{ ...validNotification, timestamp: undefined }])).toThrow(
      DatasetValidationError
    );
  });

  it("rejects timestamps that do not parse as real dates (round-8 tightening)", () => {
    expect(() => validateDataset("reports", [{ ...validReport, timestamp: "now" }])).toThrow(
      DatasetValidationError
    );
    expect(() => validateDataset("reports", [{ ...validReport, timestamp: "متفرغ" }])).toThrow(
      DatasetValidationError
    );
    expect(() => validateDataset("satellites", [{ ...validSatellite, scanTime: "recent" }])).toThrow(
      DatasetValidationError
    );
    expect(() => validateDataset("notifications", [{ ...validNotification, timestamp: "yesterday" }])).toThrow(
      DatasetValidationError
    );
    expect(validateDataset("reports", [{ ...validReport, timestamp: "2026-08-10T09:30:00.000Z" }])).toHaveLength(1);
  });

  it("rejects fractional counts (counters must be whole numbers, matching the mesh contract)", () => {
    expect(() => validateDataset("reports", [{ ...validReport, consensusCount: 2.5 }])).toThrow(
      DatasetValidationError
    );
    expect(() => validateDataset("reports", [{ ...validReport, consensusCount: -1 }])).toThrow(
      DatasetValidationError
    );
    expect(() => validateDataset("wilayas", [{ ...validWilaya, activeFires: 1.5 }])).toThrow(
      DatasetValidationError
    );
    expect(() => validateDataset("wilayas", [{ ...validWilaya, satelliteHotspots: 0.25 }])).toThrow(
      DatasetValidationError
    );
    expect(validateDataset("reports", [{ ...validReport, consensusCount: 0 }])).toHaveLength(1);
  });
});

describe("isValidReport (single-item gate for non-poll writers)", () => {
  it("admits the same contract as the GET validator", () => {
    expect(isValidReport(validReport)).toBe(true);
    expect(isValidReport({ id: "r" })).toBe(false);
    expect(isValidReport(undefined)).toBe(false);
  });

  it("exports the exact status/severity sets used by the contract", () => {
    expect(REPORT_STATUSES).toContain("pending");
    expect(REPORT_STATUSES).toContain("resolved");
    expect(REPORT_SEVERITIES).toContain("critical");
    expect([...REPORT_STATUSES, ...REPORT_SEVERITIES].length).toBe(8);
  });
});