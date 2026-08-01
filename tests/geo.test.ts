import { describe, it, expect } from "vitest";
import { getHaversineDistance, determineWilayaByCoords, runClustering } from "../server/geo.js";
import type { Report } from "../src/types";

describe("getHaversineDistance", () => {
  it("returns 0 for same point", () => {
    expect(getHaversineDistance(36.8, 7.5, 36.8, 7.5)).toBe(0);
  });

  it("returns correct distance between known points", () => {
    const dist = getHaversineDistance(36.75, 7.5, 36.85, 7.5);
    expect(dist).toBeGreaterThan(10);
    expect(dist).toBeLessThan(12);
  });

  it("is symmetric", () => {
    const a = getHaversineDistance(36.8, 7.5, 35.0, 6.0);
    const b = getHaversineDistance(35.0, 6.0, 36.8, 7.5);
    expect(Math.abs(a - b)).toBeLessThan(0.001);
  });
});

describe("determineWilayaByCoords", () => {
  it("identifies El Tarf, Algeria", () => {
    const result = determineWilayaByCoords(36.885, 8.423);
    expect(result).toContain("الطارف");
  });

  it("identifies Jendouba, Tunisia", () => {
    const result = determineWilayaByCoords(36.65, 8.78);
    expect(result).toContain("جندوبة");
  });

  it("identifies Tangier, Morocco", () => {
    const result = determineWilayaByCoords(35.58, -5.36);
    expect(result).toContain("طنجة");
  });

  it("identifies Al Jabal al Akhdar, Libya", () => {
    const result = determineWilayaByCoords(32.75, 21.85);
    expect(result).toContain("الجبل الأخضر");
  });

  it("no overlap: El Tarf vs Annaba boundary", () => {
    expect(determineWilayaByCoords(36.8, 8.2)).toContain("الطارف");
    expect(determineWilayaByCoords(36.85, 7.6)).toContain("عنابة");
    expect(determineWilayaByCoords(36.9, 7.9)).not.toContain("الطارف");
  });

  it("no overlap: Béjaïa vs Tizi Ouzou boundary", () => {
    expect(determineWilayaByCoords(36.6, 5.0)).toContain("بجاية");
    expect(determineWilayaByCoords(36.6, 4.2)).toContain("تيزي وزو");
    expect(determineWilayaByCoords(36.7, 4.45)).not.toContain("بجاية");
    expect(determineWilayaByCoords(36.7, 5.0)).not.toContain("تيزي وزو");
  });
});

describe("runClustering", () => {
  it("clusters nearby reports", () => {
    const reports: Report[] = [
      { id: "a", lat: 36.88, lng: 8.42, severity: "high", status: "verified", timestamp: new Date().toISOString(), consensusCount: 5, reporterType: "citizen", locationName: "A", wilaya: "test", description: "test" },
      { id: "b", lat: 36.882, lng: 8.425, severity: "high", status: "verified", timestamp: new Date().toISOString(), consensusCount: 3, reporterType: "citizen", locationName: "B", wilaya: "test", description: "test" },
      { id: "c", lat: 37.0, lng: 9.0, severity: "medium", status: "pending", timestamp: new Date().toISOString(), consensusCount: 1, reporterType: "citizen", locationName: "C", wilaya: "test", description: "test" },
    ];
    const result = runClustering(reports);
    const clusterA = result.find((r) => r.id === "a");
    const clusterB = result.find((r) => r.id === "b");
    const clusterC = result.find((r) => r.id === "c");
    expect(clusterA?.clusterId).toBe(clusterB?.clusterId);
    expect(clusterA?.clusterSize).toBe(2);
    expect(clusterC?.clusterSize).toBe(1);
  });

  it("does not cluster distant reports", () => {
    const reports: Report[] = [
      { id: "a", lat: 36.88, lng: 8.42, severity: "low", status: "pending", timestamp: new Date().toISOString(), consensusCount: 1, reporterType: "citizen", locationName: "A", wilaya: "test", description: "test" },
      { id: "b", lat: 37.0, lng: 9.0, severity: "low", status: "pending", timestamp: new Date().toISOString(), consensusCount: 1, reporterType: "citizen", locationName: "B", wilaya: "test", description: "test" },
    ];
    const result = runClustering(reports);
    expect(result[0].clusterSize).toBe(1);
    expect(result[1].clusterSize).toBe(1);
    expect(result[0].clusterId).not.toBe(result[1].clusterId);
  });
});
