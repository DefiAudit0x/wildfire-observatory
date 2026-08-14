import { describe, expect, it } from "vitest";
import { getConfirmationErrorMessage } from "../src/utils/confirmationErrors";

describe("confirmation error localization", () => {
  it("keeps fallback errors in Arabic for Arabic UI", () => {
    expect(getConfirmationErrorMessage("CONFIRMATION_FAILED", true)).toBe("تعذر تسجيل التأكيد");
  });

  it("does not leak Arabic fallback errors into French UI", () => {
    expect(getConfirmationErrorMessage("INVALID_CONFIRMATION_RESPONSE", false)).toBe("Réponse invalide du serveur de confirmation");
  });

  it("localizes timeout errors", () => {
    expect(getConfirmationErrorMessage("CONFIRMATION_TIMEOUT", false)).toBe("La confirmation a dépassé le délai d'attente");
  });
});
