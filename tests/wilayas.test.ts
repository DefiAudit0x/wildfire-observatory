import { describe, it, expect } from "vitest";
import { wilayaMatches } from "../server/routes/wilayas.js";

const EL_TARF = { nameAr: "الجزائر - الطارف", nameFr: "Algérie - El Tarf" };
const TIZI = { nameAr: "الجزائر - تيزي وزو", nameFr: "Algérie - Tizi Ouzou" };
const JIJEL = { nameAr: "الجزائر - جيجل", nameFr: "Algérie - Jijel" };

describe("wilayaMatches", () => {
  it("matches exact French name", () => {
    expect(wilayaMatches("El Tarf", EL_TARF.nameAr, EL_TARF.nameFr)).toBe(true);
  });

  it("matches exact Arabic name", () => {
    expect(wilayaMatches("الطارف", EL_TARF.nameAr, EL_TARF.nameFr)).toBe(true);
  });

  it("matches with wilaya prefix", () => {
    expect(wilayaMatches("ولاية الطارف", EL_TARF.nameAr, EL_TARF.nameFr)).toBe(true);
    expect(wilayaMatches("Wilaya d'El Tarf", EL_TARF.nameAr, EL_TARF.nameFr)).toBe(true);
  });

  it("matches satellite label format", () => {
    expect(
      wilayaMatches("الجزائر - تيزي وزو (Algérie - Tizi Ouzou)", TIZI.nameAr, TIZI.nameFr)
    ).toBe(true);
  });

  it("does not match wrong wilaya", () => {
    expect(wilayaMatches("Jijel", EL_TARF.nameAr, EL_TARF.nameFr)).toBe(false);
    expect(wilayaMatches("جيجل", EL_TARF.nameAr, EL_TARF.nameFr)).toBe(false);
    expect(wilayaMatches("Tizi Ouzou", JIJEL.nameAr, JIJEL.nameFr)).toBe(false);
  });

  it("handles empty or gibberish input", () => {
    expect(wilayaMatches("", EL_TARF.nameAr, EL_TARF.nameFr)).toBe(false);
    expect(wilayaMatches("zzzzqqqq", EL_TARF.nameAr, EL_TARF.nameFr)).toBe(false);
  });
});
