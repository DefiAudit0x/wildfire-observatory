import { describe, it, expect } from "vitest";
import { validateDataset, DatasetValidationError } from "../src/utils/datasetValidators.js";

const validReport = { id: "r1", lat: 36.8, lng: 7.6 };
const validSatellite = { id: "s1", lat: 36.8, lng: 7.6 };
const validSos = { id: "sos1", lat: 36.8, lng: 7.6 };
const validWilaya = { nameAr: "الطارف", nameFr: "El Tarf" };
const validNotification = { id: "n1", titleAr: "أ", titleFr: "a", read: true };

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

  it("fails on a non-array payload no matter how valid the JSON is", () => {
    for (const key of ["reports", "satellites", "wilayas", "sos", "notifications"] as const) {
      expect(() => validateDataset(key, { error: "temporary malformed response" })).toThrow(DatasetValidationError);
      expect(() => validateDataset(key, null)).toThrow(DatasetValidationError);
      expect(() => validateDataset(key, "string")).toThrow(DatasetValidationError);
    }
  });

  it("fails the WHOLE dataset when any single item is malformed — never a partial wipe", () => {
    expect(() => validateDataset("reports", [validReport, { id: 42, lat: "x", lng: null }])).toThrow(DatasetValidationError);
    expect(() => validateDataset("satellites", [validSatellite, {}])).toThrow(DatasetValidationError);
    expect(() => validateDataset("sos", [validSos, { id: "", lat: NaN, lng: 0 }])).toThrow(DatasetValidationError);
    expect(() => validateDataset("wilayas", [validWilaya, { nameAr: "" }])).toThrow(DatasetValidationError);
    expect(() => validateDataset("notifications", [validNotification, { titleFr: 1 }])).toThrow(DatasetValidationError);
  });
});