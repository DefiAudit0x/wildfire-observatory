export type ConfirmationErrorCode =
  | "CONFIRMATION_FAILED"
  | "INVALID_CONFIRMATION_RESPONSE"
  | "CONFIRMATION_TIMEOUT"
  | "CONFIRMATION_CONNECTION_FAILED";

export function getConfirmationErrorMessage(code: ConfirmationErrorCode, isArabic: boolean): string {
  const messages: Record<ConfirmationErrorCode, { ar: string; fr: string }> = {
    CONFIRMATION_FAILED: {
      ar: "تعذر تسجيل التأكيد",
      fr: "Impossible d'enregistrer la confirmation",
    },
    INVALID_CONFIRMATION_RESPONSE: {
      ar: "استجابة غير صالحة من خادم التأكيد",
      fr: "Réponse invalide du serveur de confirmation",
    },
    CONFIRMATION_TIMEOUT: {
      ar: "انتهت مهلة التأكيد",
      fr: "La confirmation a dépassé le délai d'attente",
    },
    CONFIRMATION_CONNECTION_FAILED: {
      ar: "تعذر الاتصال بخادم التأكيد",
      fr: "Impossible de contacter le serveur de confirmation",
    },
  };

  return isArabic ? messages[code].ar : messages[code].fr;
}
