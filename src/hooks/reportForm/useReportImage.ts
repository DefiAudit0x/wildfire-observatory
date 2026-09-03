import { useRef, useState } from "react";
import type { EdgeAiStatusView } from "./reportFormShared";

/**
 * ARC-H13 — THE owner of the image-attachment concern: file validation
 * (ARC-M23: the input value reset so re-selecting the SAME photo fires a real
 * change event), smart canvas compression (600px cap, 480KB honest ceiling),
 * the EXIF/GPS non-proof warning for file uploads, and the lightweight
 * ON-DEVICE color-heuristic pre-scan.
 *
 * The pre-scan NEVER verifies a report — final verification is done by the
 * backend Gemini vision model. It only nudges the user to frame the fire
 * clearly; its copy says so in both languages.
 */
export interface UseReportImageParams {
  isArabic: boolean;
  setErrorMsg: (message: string | null) => void;
}

export function useReportImage({ isArabic, setErrorMsg }: UseReportImageParams) {
  const [image, setImage] = useState<string | null>(null);
  const [originalSize, setOriginalSize] = useState<string | null>(null);
  const [compressedSize, setCompressedSize] = useState<string | null>(null);
  const [isCompressing, setIsCompressing] = useState(false);
  const [uploadWarning, setUploadWarning] = useState<string | null>(null);
  const [edgeAiStatus, setEdgeAiStatus] = useState<EdgeAiStatusView | null>(null);
  const prescanCounter = useRef(0);

  // --- LIGHTWEIGHT ON-DEVICE HEURISTIC PRE-SCANNER ---
  // Note: this is a coarse color-based heuristic (feasible in-browser without a
  // model download). It never verifies a report — final verification is done
  // by the backend Gemini vision model. It only nudges the user to frame the
  // fire clearly.
  const runEdgeAiPreScan = (dataUrl: string, compressionPercent: number | null = null) => {
    const ticket = ++prescanCounter.current;
    const tempImg = new Image();
    tempImg.onload = () => {
      if (ticket !== prescanCounter.current) return; // superseded capture
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = 50;
      tempCanvas.height = 50;
      const tempCtx = tempCanvas.getContext("2d");
      if (!tempCtx) return;

      tempCtx.drawImage(tempImg, 0, 0, 50, 50);
      const imgData = tempCtx.getImageData(0, 0, 50, 50).data;

      let fireScore = 0;
      let smokeScore = 0;
      for (let i = 0; i < imgData.length; i += 4) {
        const r = imgData[i];
        const g = imgData[i+1];
        const b = imgData[i+2];

        // Fire colors: High Red, moderate Green, low Blue
        if (r > 130 && g > 55 && r > g * 1.3 && b < 100) {
          fireScore++;
        }
        // Smoke colors: Gray, muted, near-equal R, G, B channels
        if (Math.abs(r - g) < 20 && Math.abs(g - b) < 20 && r > 90 && r < 210) {
          smokeScore++;
        }
      }

      const totalPixels = 50 * 50;
      const fireRatio = fireScore / totalPixels;
      const smokeRatio = smokeScore / totalPixels;
      const baseConfidence = (fireRatio * 600) + (smokeRatio * 400);
      const confidence = Math.max(10, Math.min(99, Math.round(baseConfidence)));

      if (fireRatio > 0.008 || smokeRatio > 0.02) {
        setEdgeAiStatus({
          success: true,
          confidence: Math.max(50, confidence),
          messageAr: `🔎 فحص لوني بصري أولي (تقديري فقط — لا يُثبت وجود حريق؛ التحقق النهائي يتم بالذكاء الاصطناعي في الخادم عند وصول البلاغ): ألوان متوافقة مع ظلال نارية/دخانية (${Math.max(50, confidence)}%). تم ضغط الصورة بنسبة ${compressionPercent ?? 0}%.`,
          messageFr: `🔎 Pré-scan visuel local (heuristique couleur uniquement — ne constitue pas une preuve ; la vérification finale est faite par l'IA serveur) : teintes compatibles feu/fumée (${Math.max(50, confidence)}%). Image compressée à ${compressionPercent ?? 0}%.`
        });
      } else {
        setEdgeAiStatus({
          success: false,
          confidence,
          messageAr: `⚠️ فحص لوني بصري أولي (تقديري فقط — لا يُثبت عدم وجود حريق): لم تُرصد تدرجات نارية/دخانية واضحة (${confidence}%). الالتقاط المقرّب والصريح يساعد التحقق الخادمي.`,
          messageFr: `⚠️ Pré-scan visuel local : contraste feu/fumée faible (≈${confidence}%). Cadrez clairement pour faciliter la vérification serveur.`
        });
      }
    };
    tempImg.src = dataUrl;
  };

  // Image Upload & Smart Canvas Compression with Edge AI integration
  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // ARC-M23 fix: the input value was never reset, so re-selecting the SAME
    // photo fired no change event and the button appeared dead. Clearing the
    // input value here (the File object is already captured) makes every
    // selection — including the same file twice — a real change event.
    e.target.value = "";
    if (!file) return;
    const isImageType = file.type.startsWith("image/");
    const MAX_INPUT_BYTES = 15 * 1024 * 1024;
    if (!isImageType || file.size > MAX_INPUT_BYTES) {
      setErrorMsg(isArabic ? "الصورة غير صالحة أو أكبر من 15 ميغابايت." : "Image invalide ou supérieure à 15 Mo.");
      e.target.value = "";
      return;
    }
    setErrorMsg(null);
    setOriginalSize((file.size / 1024).toFixed(1) + " KB");
    setIsCompressing(true);

    const reader = new FileReader();
    reader.onerror = () => {
      setIsCompressing(false);
      setImage(null);
      setErrorMsg(isArabic ? "تعذر قراءة الصورة المحددة." : "Impossible de lire l'image sélectionnée.");
    };
    reader.onload = (event) => {
      const img = new Image();
      img.onerror = () => {
        setIsCompressing(false);
        setImage(null);
        setErrorMsg(isArabic ? "الصورة تالفة أو غير قابلة للفك." : "L'image est corrompue ou illisible.");
      };
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");

        const MAX_WIDTH = 600;
        const MAX_HEIGHT = 600;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;

        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
          setImage(dataUrl);

          const stringLength = dataUrl.length - "data:image/jpeg;base64,".length;
          const sizeInBytes = stringLength * (3 / 4);
          if (sizeInBytes > 480_000) {
            setImage(null);
            setCompressedSize(null);
            setUploadWarning(isArabic ? "الصورة المضغوطة ما زالت كبيرة جدًا للإرسال الآمن." : "L'image compressée reste trop volumineuse pour un envoi sûr.");
            setIsCompressing(false);
            return;
          }
          setCompressedSize((sizeInBytes / 1024).toFixed(1) + " KB");

          const compressionPercent = file.size > 0
            ? Math.min(99, Math.max(0, Math.round((1 - sizeInBytes / file.size) * 100)))
            : 0;

          // Trigger local Edge AI analysis immediately
          runEdgeAiPreScan(dataUrl, compressionPercent);
          // A file upload has no in-app telemetry overlay. EXIF/GPS metadata is
          // not inspected here, so it must not be described as absent or proof.
          setUploadWarning(
            isArabic
              ? "⚠️ الصور المرفوعة لا تتضمن ختم القياس الميداني الخاص بالتصوير المباشر. لا يفحص التطبيق بيانات EXIF/GPS، لذلك لا تُعد هذه البيانات إثباتًا مستقلًا."
              : "⚠️ Les photos jointes n'ont pas le marquage de télémétrie de la capture directe. L'application ne vérifie pas les métadonnées EXIF/GPS; elles ne constituent donc pas une preuve indépendante."
          );
        }
        setIsCompressing(false);
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  // A LIVE capture carries the GPS/UTC stamp inside the frame pixels; a file
  // upload does not (the upload path warns about that instead).
  const applyCapturedImage = (dataUrl: string) => {
    setImage(dataUrl);
    setUploadWarning(null);
  };

  // Reset applied after an accepted submission (ported verbatim from the
  // original success path: image + sizes + AI status).
  const resetImage = () => {
    setImage(null);
    setOriginalSize(null);
    setCompressedSize(null);
    setEdgeAiStatus(null);
  };

  return {
    image,
    originalSize,
    compressedSize,
    isCompressing,
    uploadWarning,
    edgeAiStatus,
    handleImageChange,
    applyCapturedImage,
    runEdgeAiPreScan,
    resetImage,
  };
}
