import { useEffect, useRef, useState, useCallback } from "react";
import { AlertTriangle, MapPin, Mic, RadioReceiver, ShieldAlert, X, Volume2, Activity, ShieldCheck, RefreshCw } from "lucide-react";
import { getDeviceId } from "../utils/device";
import { useModalA11y } from "../hooks/useModalA11y";

interface TrappedSOSModalProps {
  lang: "ar" | "fr";
  onClose: () => void;
  userLocation: { lat: number; lng: number } | null;
  /** Only a confirmed citizen report within 10 km can establish imminent danger. */
  nearestThreat?: { distanceM: number; kind: "report" | "satellite"; confirmed?: boolean } | null;
}

type Step =
  | "verifying"
  | "no_location"
  | "no_fires"
  | "verified"
  | "recording"
  | "send_failed"
  | "sent";

const MAX_AUDIO_DURATION_SEC = 20;

export function toUserFacingSosError(message: string | undefined, isArabic: boolean): string {
  const normalized = message?.toLowerCase() || "";
  if (normalized.includes("sos_storage_unavailable") || normalized.includes("sos storage unavailable")) {
    return isArabic
      ? "لم يتم حفظ نداء الاستغاثة على الخادم بعد. أعد المحاولة أو اتصل مباشرةً بالحماية المدنية."
      : "L'appel SOS n'a pas encore été enregistré sur le serveur. Réessayez ou appelez directement la protection civile.";
  }
  if (normalized.includes("already received recently")) {
    return isArabic
      ? "يوجد نداء استغاثة حديث من هذا الجهاز. إذا لم تحصل على مساعدة، اتصل مباشرةً بالحماية المدنية."
      : "Un SOS récent existe déjà pour cet appareil. Si vous n'avez pas d'aide, appelez directement la protection civile.";
  }
  return isArabic ? "تعذّر إرسال نداء الاستغاثة. أعد المحاولة أو اتصل مباشرةً بالحماية المدنية." : "Impossible d'envoyer le SOS. Réessayez ou appelez directement la protection civile.";
}

export default function TrappedSOSModal({ lang, onClose, userLocation, nearestThreat }: TrappedSOSModalProps) {
  const isArabic = lang === "ar";
  const [step, setStep] = useState<Step>("verifying");
  const [nearestThreatState, setNearestThreatState] = useState<TrappedSOSModalProps["nearestThreat"]>(nearestThreat ?? null);
  const [recordingTime, setRecordingTime] = useState(0);
  const [name, setName] = useState("");
  // ARC-L17: this phone field deliberately has NO validation policy — the SOS
  // path is life-safety and must accept any string (see src/utils/phone.ts for
  // the centralized policies used by the other citizen windows).
  const [phone, setPhone] = useState("");
  const [isTestingSound, setIsTestingSound] = useState(false);
  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  // Fix 27 (SOSM-3): the modal can unmount while getUserMedia is pending
  // (the header close button stays live during the await). The flag is
  // flipped false by the unmount cleanup and checked the moment the
  // permission await resolves — a granted stream for a dead modal is
  // stopped at once, never stored, recorded, analysed, or timed.
  const mountedRef = useRef(true);
  const recordingGenerationRef = useRef(0);
  // Fix 27 (SOSM-2): the timer callback must read the current count without
  // closing over stale state — and the stop must not live inside a state
  // updater (StrictMode double-invokes updaters in dev).
  const recordingTimeRef = useRef(0);
  // W-H3: full modal a11y contract (dialog role, focus trap, Escape, focus
  // restore). Escape is suppressed while RECORDING — a stray keystroke must
  // never discard a trapped person's voice note — and while SENDING.
  const overlayRef = useModalA11y<HTMLDivElement>({
    onCancel: onClose,
    suppressEscape: step === "recording" || isSending,
  });
  const audioCtxRef = useRef<AudioContext | null>(null);
  // W-H1: the recording visualizer minted its OWN AudioContext per recording
  // and never closed it — one leaked context per take, plus the synthetic
  // fallback's context on its error path. Every context the modal creates is
  // now tracked and closed deterministically.
  const recordingAudioCtxRef = useRef<AudioContext | null>(null);
  // W-H2: the first successful recording is cached here — a retry after a
  // send failure reuses the REAL recording instead of silently replacing it
  // with a freshly synthesized siren (and never sends an empty audio body).
  const capturedAudioRef = useRef<string>("");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  // Fix 27b: per-recording completion promise, resolved by the onstop
  // handler with the converted audio. stop() flips state to "inactive"
  // synchronously while the final dataavailable slice is still a queued
  // task — a Send landing in that window must wait for this promise
  // instead of snapshotting the chunks immediately, or the very take
  // SOSM-2 exists to preserve whole goes out missing its last ~100 ms.
  const recordingDoneRef = useRef<{ promise: Promise<string>; resolve: (audio: string) => void } | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  // F4 mirror: mint the SOS idempotency key ONCE per modal session and reuse
  // it across retries — the server replays the FIRST stored SOS for the same
  // key, so a retry after a timeout can never become a second emergency call.
  const sosClientGeneratedIdRef = useRef<string | null>(null);

  // Fix 37 (SOSM-4): a late profile load must not overwrite identity the
  // user already typed. The []-deps effect below closes over mount-time ""
  // forever, so an "only fill when empty" guard would be vacuous — per-field
  // dirty refs are the only correct mechanism.
  const nameTouchedRef = useRef(false);
  const phoneTouchedRef = useRef(false);
  const handleNameChange = (value: string) => {
    nameTouchedRef.current = true;
    setName(value);
  };
  const handlePhoneChange = (value: string) => {
    phoneTouchedRef.current = true;
    setPhone(value);
  };

  // Load the user's saved (server-encrypted) identity once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/sos/profile/current");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (!nameTouchedRef.current) setName(data.name || "");
        if (!phoneTouchedRef.current) setPhone(data.phone || "");
      } catch {
        // fall back to empty identity (session-only) if profile is unavailable
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const playSOSTestSound = () => {
    if (isTestingSound) {
      if (audioCtxRef.current) {
        try {
          audioCtxRef.current.close();
        } catch {
          // ignore
        }
        audioCtxRef.current = null;
      }
      setIsTestingSound(false);
      return;
    }

    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;
      setIsTestingSound(true);

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(880, ctx.currentTime);

      let isHigh = false;
      const interval = setInterval(() => {
        if (!audioCtxRef.current || ctx.state === "closed") {
          clearInterval(interval);
          return;
        }
        isHigh = !isHigh;
        osc.frequency.setValueAtTime(isHigh ? 1760 : 880, ctx.currentTime);
      }, 200);

      gain.gain.setValueAtTime(0.25, ctx.currentTime);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();

      setTimeout(() => {
        clearInterval(interval);
        if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
          audioCtxRef.current.close();
        }
        audioCtxRef.current = null;
        setIsTestingSound(false);
      }, 4000);

    } catch (e) {
      console.error("Audio test error:", e);
      setIsTestingSound(false);
    }
  };

  useEffect(() => {
    // Fix 27 review (Minor 1): StrictMode double-invokes this effect in
    // dev (setup → cleanup → setup) with the SAME ref objects — without
    // this reset the cleanup's `false` would stick for the component's
    // lifetime and the first startRecording would discard the granted
    // stream as "disposed". Production builds don't double-invoke, but the
    // flag's lifecycle must be right regardless.
    mountedRef.current = true;
    return () => {
      // Fix 27 (SOSM-3): flip first — anything a pending getUserMedia
      // resolves into after this point belongs to a dead modal.
      mountedRef.current = false;
      // ARC-M19 fix: unmounting mid-recording (user closes the modal early)
      // used to leave the 1-second recording timer and the audio-level
      // animation loop running against an unmounted component, while the mic
      // stream and audio context were already stopped here.
      if (timerRef.current) clearInterval(timerRef.current);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (audioCtxRef.current) {
        try { audioCtxRef.current.close(); } catch { /* ignore */ }
      }
      // W-H1: the per-recording analyzer context is closed here too, not just
      // the siren-test context.
      if (recordingAudioCtxRef.current) {
        try { recordingAudioCtxRef.current.close(); } catch { /* ignore */ }
        recordingAudioCtxRef.current = null;
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  // Honest verification: report real risk detection, never fabricate a distance.
  // Fix 27 (SOSM-1): this effect is the PRE-recording verification only. Once
  // the user has started recording (or sending/sent/failed), a fresh GPS fix
  // or a new threat object must not reset the flow — the recorder keeps
  // running, the success screen stays, and Escape stays suppressed.
  useEffect(() => {
    if (step !== "verifying" && step !== "no_location" && step !== "no_fires" && step !== "verified") return;
    if (!userLocation) {
      setStep("no_location");
      setNearestThreatState(null);
      return;
    }
    if (nearestThreat == null || nearestThreat.confirmed !== true || nearestThreat.kind !== "report" ||
        !Number.isFinite(nearestThreat.distanceM) || nearestThreat.distanceM < 0 || nearestThreat.distanceM > 10_000) {
      setStep("no_fires");
      setNearestThreatState(null);
      return;
    }
    setNearestThreatState(nearestThreat);
    setStep("verified");
  }, [userLocation, nearestThreat, step]);

  const [micStatus, setMicStatus] = useState<"idle" | "recording" | "permission_denied">("idle");
  // Fix 27 (SOSM-2): true once the 20 s limit stopped the recorder — the
  // "speak now" line would be a lie then (the mic is already dead).
  const [recordingComplete, setRecordingComplete] = useState(false);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const animFrameRef = useRef<number | null>(null);

  // Fix 27 (SOSM-2): the recorded chunks → base64 conversion, shared by the
  // manual stop and the timer auto-stop. Resolves "" when there is no real
  // audio (blob ≤ 200 bytes — the same threshold stopRecordingAndSend uses).
  const chunksToBase64 = async (): Promise<string> => {
    try {
      const mimeType = mediaRecorderRef.current?.mimeType || "audio/webm";
      const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
      if (audioBlob.size <= 200) return "";
      return await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = () => resolve("");
        reader.readAsDataURL(audioBlob);
      });
    } catch {
      return "";
    }
  };

  const startRecording = async () => {
    const generation = ++recordingGenerationRef.current;
    setStep("recording");
    setRecordingTime(0);
    recordingTimeRef.current = 0;
    setRecordingComplete(false);
    setMicStatus("recording");
    setSendError(null);
    audioChunksRef.current = [];

    // Attempt real microphone recording
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Fix 27 (SOSM-3): the user may have closed the modal while the
        // permission prompt was open. A granted stream for a dead modal must
        // be stopped at once — never stored, recorded, analysed, or timed.
        if (!mountedRef.current || generation !== recordingGenerationRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        mediaStreamRef.current = stream;

        let mimeType = "";
        if (typeof MediaRecorder !== "undefined") {
          if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) mimeType = "audio/webm;codecs=opus";
          else if (MediaRecorder.isTypeSupported("audio/webm")) mimeType = "audio/webm";
          else if (MediaRecorder.isTypeSupported("audio/mp4")) mimeType = "audio/mp4";
          else if (MediaRecorder.isTypeSupported("audio/ogg")) mimeType = "audio/ogg";
        }

        const options = mimeType ? { mimeType } : undefined;
        const mediaRecorder = new MediaRecorder(stream, options);
        mediaRecorderRef.current = mediaRecorder;

        // Fix 27b: mint the per-recording completion promise here — the
        // onstop handler below resolves it with the converted audio once
        // the final dataavailable slice has landed.
        let resolveRecordingDone!: (audio: string) => void;
        const recordingDone = new Promise<string>((resolve) => { resolveRecordingDone = resolve; });
        recordingDoneRef.current = { promise: recordingDone, resolve: resolveRecordingDone };

        mediaRecorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };
        // Fix 27 (SOSM-2): the timer stops this recorder without going through
        // stopRecordingAndSend, so the conversion must live on the recorder
        // itself — otherwise the auto-stopped take is never turned into audio
        // and Send falls back to the synthetic siren. stopRecordingAndSend
        // overwrites onstop with its own handler before calling stop() on
        // the manual path, so the manual path is unaffected.
        mediaRecorder.onstop = async () => {
          const base64 = await chunksToBase64();
          if (base64 && base64.length >= 100) capturedAudioRef.current = base64;
          // Fix 27b: resolve with the converted audio even when it is
          // empty/short — a waiter must never hang on a failed take.
          recordingDoneRef.current?.resolve(base64);
        };

        // Real-time audio analyzer for visualizer meter
        try {
          const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
          const audioCtx = new AudioCtx();
          // W-H1: tracked so stopRecordingAndSend + unmount can always close it.
          recordingAudioCtxRef.current = audioCtx;
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 64;
          source.connect(analyser);

          const dataArray = new Uint8Array(analyser.frequencyBinCount);
          let lastLevelUpdate = 0;
          const updateLevel = () => {
            animFrameRef.current = requestAnimationFrame(updateLevel);
            // v1.0.4 field fix: sample the analyser at ~10 fps instead of
            // every animation frame — the old 60 fps setState re-rendered the
            // ENTIRE SOS modal (header, steps, buttons) up to 60 times per
            // second, stalling low-end WebView devices mid-recording.
            const now = performance.now();
            if (now - lastLevelUpdate < 100) return;
            lastLevelUpdate = now;
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
              sum += dataArray[i];
            }
            const avg = sum / dataArray.length;
            setAudioLevel(avg);
          };
          updateLevel();
        } catch {
          // Ignore analyzer error if any
        }

        mediaRecorder.start(100);
      } else {
        setMicStatus("permission_denied");
      }
    } catch (err) {
      if (!mountedRef.current || generation !== recordingGenerationRef.current) return;
      console.warn("Microphone access unavailable or denied:", err);
      setMicStatus("permission_denied");
    }

    if (!mountedRef.current || generation !== recordingGenerationRef.current) return;

    // Fix 27 (SOSM-2): the stop is a plain statement now, not a side effect
    // inside the setRecordingTime updater (StrictMode double-invokes updaters
    // in dev). The display reaches 20 — the old `return prev` froze it at 19.
    timerRef.current = setInterval(() => {
      const next = recordingTimeRef.current + 1;
      if (next >= MAX_AUDIO_DURATION_SEC) {
        if (timerRef.current) clearInterval(timerRef.current);
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
          try { mediaRecorderRef.current.stop(); } catch { /* ignore */ }
        }
        if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach((track) => track.stop());
          mediaStreamRef.current = null;
        }
        if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
        if (recordingAudioCtxRef.current) {
          try { recordingAudioCtxRef.current.close(); } catch { /* ignore */ }
          recordingAudioCtxRef.current = null;
        }
        recordingTimeRef.current = MAX_AUDIO_DURATION_SEC;
        setRecordingTime(MAX_AUDIO_DURATION_SEC);
        // Only a real recorder reached the limit — with a denied mic there
        // is no take to complete, and the amber warning below stays the
        // honest message.
        if (mediaRecorderRef.current) setRecordingComplete(true);
        return;
      }
      recordingTimeRef.current = next;
      setRecordingTime(next);
    }, 1000);
  };

  // Build an informative text payload that travels with the SOS and can be
  // shown to responders even if no audio could be captured.
  const buildTextMessage = (finalName: string): string => {
    return [
      "استغاثة طارئة",
      finalName ? `الأسم: ${finalName}` : "شخص محاصر بالنيران",
      phone.trim() ? `الهاتف: ${phone.trim()}` : "",
      userLocation ? `الموقع: ${userLocation.lat.toFixed(4)}, ${userLocation.lng.toFixed(4)}` : "",
    ].filter(Boolean).join(". ") + ".";
  };

  // Generate an emergency alert audio when mic isn't permitted. The sound is a
  // siren-like tone; the informative payload travels as `textMessage`.
  const generateVoiceAlertBase64 = async (finalName: string): Promise<string> => {
    return new Promise((resolve) => {
      let ctx: AudioContext | null = null;
      try {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctx = new AudioCtx();
        const dest = ctx.createMediaStreamDestination();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = "sine";
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.5);
        osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 1.0);

        gain.gain.setValueAtTime(0.4, ctx.currentTime);

        osc.connect(gain);
        gain.connect(dest);
        osc.start();

        const recorder = new MediaRecorder(dest.stream);
        const chunks: Blob[] = [];
        recorder.ondataavailable = e => chunks.push(e.data);
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: "audio/webm" });
          const reader = new FileReader();
          const closeCtx = () => {
            // W-H1: the synthetic-alert context is closed on EVERY terminal
            // path, not only the happy reader.onloadend one.
            try { ctx?.close(); } catch { /* ignore */ }
          };
          reader.onloadend = () => {
            resolve(reader.result as string);
            closeCtx();
          };
          reader.onerror = () => {
            resolve("");
            closeCtx();
          };
          reader.readAsDataURL(blob);
        };

        recorder.start();
        setTimeout(() => {
          recorder.stop();
          osc.stop();
        }, 3000);
      } catch {
        // W-H1: a failure AFTER the context was created must not leak it.
        try { ctx?.close(); } catch { /* ignore */ }
        resolve("");
      }
    });
  };

  const speakEmergency = useCallback((finalName: string) => {
    if (!("speechSynthesis" in window)) return;
    try {
      const text = buildTextMessage(finalName);
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "ar-SA";
      utterance.rate = 0.9;
      window.speechSynthesis.speak(utterance);
    } catch {
      // ignore
    }
  }, [phone, userLocation]);

  const stopRecordingAndSend = async () => {
    recordingGenerationRef.current += 1;
    if (timerRef.current) clearInterval(timerRef.current);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    setIsSending(true);
    setSendError(null);

    let finalAudioBase64 = "";

    // Stop MediaRecorder if active and await chunks
    // Fix 27b: remember whether THIS call stopped the recorder — the
    // inactive branch below must only await the onstop completion promise
    // when the recorder was stopped elsewhere (timer/browser); the manual
    // path overwrites onstop, so its promise would never resolve.
    let stoppedByThisCall = false;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      stoppedByThisCall = true;
      await new Promise<void>((resolve) => {
        if (!mediaRecorderRef.current) return resolve();
        mediaRecorderRef.current.onstop = () => {
          try {
            const mimeType = mediaRecorderRef.current?.mimeType || "audio/webm";
            const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
            if (audioBlob.size > 200) {
              const reader = new FileReader();
              reader.onloadend = () => {
                finalAudioBase64 = reader.result as string;
                resolve();
              };
              reader.readAsDataURL(audioBlob);
            } else {
              resolve();
            }
          } catch {
            resolve();
          }
        };
        try {
          mediaRecorderRef.current.stop();
        } catch {
          resolve();
        }
      });
    }

    // Fix 27 (SOSM-2): the recorder is already inactive after the timer's
    // auto-stop, but the chunks are still in memory — convert them here
    // instead of falling through to the synthetic siren. This also covers
    // any browser-initiated stop that bypassed both handlers.
    // Fix 27b: when the recorder was stopped outside this call, its final
    // dataavailable slice may still be a queued task — await the onstop
    // conversion first so the take is sent whole. The 1 s race is the
    // backstop: a recorder that never fires onstop must not hold Send
    // hostage; on timeout the immediate snapshot below runs instead.
    // Fix 27c: the wait must NOT be gated on chunks already being buffered
    // — a stop inside the first ~100 ms (before the first timeslice) leaves
    // the final slice as the ONLY audio, and gating on length > 0 would
    // discard it in favour of the siren. The length check lives on the
    // snapshot only, where it skips a pointless FileReader call.
    if ((!finalAudioBase64 || finalAudioBase64.length < 100) &&
        mediaRecorderRef.current?.state === "inactive") {
      if (!stoppedByThisCall && recordingDoneRef.current) {
        const done = await Promise.race([
          recordingDoneRef.current.promise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
        ]);
        if (done) finalAudioBase64 = done;
      }
      if (audioChunksRef.current.length > 0 && (!finalAudioBase64 || finalAudioBase64.length < 100)) {
        finalAudioBase64 = await chunksToBase64();
      }
    }

    // Stop mic stream tracks
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    // W-H1: the recording analyzer's AudioContext is done the moment the
    // recording ends — close it here instead of leaving it open until unmount.
    if (recordingAudioCtxRef.current) {
      try { recordingAudioCtxRef.current.close(); } catch { /* ignore */ }
      recordingAudioCtxRef.current = null;
    }

    // W-H2: keep the REAL recording across retries. The old flow regenerated a
    // synthetic siren on every retry (the recorder is already inactive by then)
    // and could fall back to an empty audio body — the victim's actual voice
    // note was silently discarded. Once a real take is captured it is reused
    // verbatim, and an empty/short body is never sent as audioUrl.
    if (finalAudioBase64 && finalAudioBase64.length >= 100) {
      capturedAudioRef.current = finalAudioBase64;
    } else if (capturedAudioRef.current && capturedAudioRef.current.length >= 100) {
      finalAudioBase64 = capturedAudioRef.current;
    }

    const finalName = name.trim() || (isArabic ? "مواطن محاصر" : "Citoyen Piégé");

    // If no audio chunk was captured (e.g. mic disabled), generate a synthetic
    // alert sound and speak the emergency message aloud as a live fallback.
    if ((!finalAudioBase64 || finalAudioBase64.length < 100)) {
      finalAudioBase64 = await generateVoiceAlertBase64(finalName);
      speakEmergency(finalName);
    }

    setRecordedAudioUrl(finalAudioBase64);

    if (!userLocation) {
      setSendError(isArabic ? "لا يمكن تحديد موقعك. يرجى تفعيل GPS ثم المحاولة." : "Impossible de vous localiser. Activez le GPS puis réessayez.");
      setStep("send_failed");
      setIsSending(false);
      return;
    }

    try {
      const storedId = getDeviceId();

      // 1) Persist identity on the server (encrypted, TTL) for future sessions.
      try {
        await fetch("/api/sos/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: finalName, phone: phone.trim() }),
          // Best-effort step: never let it hold the SOS hostage.
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // Non-critical: identity persistence is best-effort
      }

      // 2) Send the SOS.
      // ARC-H11 fix: this POST used to have NO timeout — on a congested or
      // half-dead connection the trapped user was stuck on "sending" forever
      // with no retry button. A 15s ceiling guarantees the failure surfaces
      // while the user still has time (and a working UI) to retry or call
      // civil protection directly.
      const res = await fetch("/api/sos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: storedId,
          clientGeneratedId:
            sosClientGeneratedIdRef.current ??=
            (globalThis.crypto?.randomUUID?.().replace(/-/g, "") ||
              `${Date.now()}${Math.random().toString(36).slice(2, 10)}`),
          lat: userLocation.lat,
          lng: userLocation.lng,
          name: finalName,
          phone: phone.trim(),
          // W-H2: only a REAL, non-trivial audio body travels — never "".
          audioUrl: finalAudioBase64 && finalAudioBase64.length >= 100 ? finalAudioBase64 : undefined,
          audioDuration: recordingTime || 5,
          textMessage: buildTextMessage(finalName),
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      await res.json();
      setStep("sent");
    } catch (err: any) {
      console.error("Failed to post SOS:", err);
      setSendError(toUserFacingSosError(err?.message, isArabic));
      setStep("send_failed");
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={isArabic ? "نداء استغاثة طارئ" : "SOS Urgence"}
      tabIndex={-1}
      className="fixed inset-0 z-[2000] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 outline-none"
    >
      {/* v1.0.4 field fix: the panel MUST scroll — the recording step alone is
          taller than a small phone viewport (mic animation + timer + warning
          block + 20-bar visualizer + send button), and with items-center +
          overflow-hidden both ends were CLIPPED, so the send button was
          unreachable (the owner could see "recording" but never send). */}
      <div className="bg-zinc-900 border border-red-500/50 rounded-2xl w-full max-w-md shadow-[0_0_50px_rgba(220,38,38,0.2)] max-h-[88dvh] overflow-y-auto overscroll-contain">
        
        {/* Header */}
        <div className="bg-red-600 p-4 flex justify-between items-center text-white">
          <h2 className="font-bold text-lg flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 animate-pulse" />
            {isArabic ? "نداء استغاثة طارئ (شخص محاصر)" : "SOS Urgence (Personne Piégée)"}
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-white/20 rounded-lg transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6">
          {step === "verifying" && (
            <div className="flex flex-col items-center justify-center py-8 text-center space-y-4">
              <div className="relative">
                <div className="absolute inset-0 bg-red-500/20 rounded-full animate-ping"></div>
                <div className="h-16 w-16 bg-red-500/20 border border-red-500 rounded-full flex items-center justify-center">
                  <MapPin className="h-8 w-8 text-red-500" />
                </div>
              </div>
              <h3 className="text-lg font-bold text-slate-100">
                {isArabic ? "جاري التحقق من موقعك..." : "Vérification de la position..."}
              </h3>
              <p className="text-sm text-slate-400">
                {isArabic
                  ? "نقارن موقعك ببؤر النيران النشطة لدعم تقييم الخطر؛ قرب الحريق لا يؤكد وحده أنك محاصر."
                  : "Votre position est comparée aux feux actifs pour contextualiser le risque ; la proximité seule ne confirme pas que vous êtes piégé."}
              </p>
            </div>
          )}

          {step === "no_location" && (
            <div className="flex flex-col items-center text-center space-y-5 py-6 animate-fadeIn">
              <div className="h-16 w-16 bg-amber-500/20 text-amber-400 rounded-full flex items-center justify-center border border-amber-500/50">
                <MapPin className="h-8 w-8" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-amber-400 mb-2">
                  {isArabic ? "تعذّر تحديد موقعك" : "Position indéterminée"}
                </h3>
                <p className="text-sm text-slate-300">
                  {isArabic
                    ? "لا يمكننا تحديد موقعك الحالي. تفعيل GPS ضروري لإرسال موقعك مع الاستغاثة."
                    : "Impossible d'identifier votre position. Activez le GPS pour transmettre votre localisation."}
                </p>
              </div>
              <div className="w-full space-y-2">
                <p className="text-xs font-bold text-amber-200">
                  {isArabic ? "إذا كنت في خطر مباشر، اتصل الآن:" : "En danger immédiat, appelez maintenant :"}
                </p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <a
                    href="tel:14"
                    className="py-2.5 rounded-xl bg-red-700 hover:bg-red-600 text-white text-xs font-black text-center transition-colors"
                  >
                    {isArabic ? "النجدة والحريق 14" : "Urgence incendie 14"}
                  </a>
                  <a
                    href="tel:1021"
                    className="py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-black text-center transition-colors"
                  >
                    {isArabic ? "الحماية المدنية 1021" : "Protection civile 1021"}
                  </a>
                  <a
                    href="tel:1070"
                    className="py-2.5 rounded-xl bg-red-950 border border-red-500/50 hover:bg-red-900 text-red-100 text-xs font-black text-center transition-colors"
                  >
                    {isArabic ? "الغابات 1070" : "Forêts 1070"}
                  </a>
                </div>
                <button
                  onClick={onClose}
                  className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-bold transition-colors cursor-pointer"
                >
                  {isArabic ? "إغلاق" : "Fermer"}
                </button>
              </div>
            </div>
          )}

          {step === "no_fires" && (
            <div className="flex flex-col items-center text-center space-y-5 py-6 animate-fadeIn">
              <div className="h-16 w-16 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center border border-emerald-500/50">
                <ShieldCheck className="h-8 w-8" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-emerald-400 mb-2">
                  {isArabic ? "لم يتأكد خطر قريب" : "Danger à proximité non confirmé"}
                </h3>
                <p className="text-sm text-slate-300">
                  {isArabic
                    ? "لم يتأكد وجود حريق نشط قريب؛ قد تكون البيانات غير مكتملة. إذا كنت في خطر، يمكنك مواصلة إرسال استغاثتك."
                    : "Les données disponibles ne confirment pas de feu actif à proximité et peuvent être incomplètes. Si vous êtes en danger, vous pouvez continuer l'alerte."}
                </p>
              </div>
              <div className="w-full space-y-3 bg-black/40 p-4 rounded-xl border border-white/5" dir={isArabic ? "rtl" : "ltr"}>
                <h4 className="text-xs font-bold text-slate-300 border-b border-white/5 pb-1.5 flex items-center gap-1.5 justify-start">
                  <span>🚨</span>
                  <span>{isArabic ? "معلومات تحديد الهوية للإنقاذ" : "Informations d'identification pour secours"}</span>
                </h4>
                <div className="space-y-1">
                  <label className="block text-[11px] font-semibold text-gray-400 text-start">
                    {isArabic ? "الاسم الكامل (اختياري)" : "Nom Complet (Optionnel)"}
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => handleNameChange(e.target.value)}
                    placeholder={isArabic ? "مثال: أحمد بوعلام" : "Ex: Ahmed Boualam"}
                    className="w-full px-3 py-2 text-xs bg-zinc-900 border border-white/10 rounded-lg text-slate-100 placeholder-gray-600 focus:outline-none focus:border-red-500/50 text-start"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-[11px] font-semibold text-gray-400 text-start">
                    {isArabic ? "رقم الهاتف للاتصال المباشر" : "Numéro téléphone direct"}
                  </label>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => handlePhoneChange(e.target.value)}
                    placeholder={isArabic ? "مثال: 0661234567" : "Ex: 0661234567"}
                    className="w-full px-3 py-2 text-xs bg-zinc-900 border border-white/10 rounded-lg text-slate-100 placeholder-gray-600 focus:outline-none focus:border-red-500/50 text-left font-mono"
                  />
                </div>
              </div>
              <button
                onClick={startRecording}
                className="w-full py-4 bg-red-600 hover:bg-red-500 text-white rounded-xl font-bold flex items-center justify-center gap-2 transition-transform hover:scale-105 active:scale-95 shadow-xl cursor-pointer"
              >
                <Mic className="h-5 w-5" />
                {isArabic ? "أنا في خطر — متابعة الاستغاثة" : "Je suis en danger — Continuer"}
              </button>
            </div>
          )}

          {step === "verified" && (
            <div className="flex flex-col items-center text-center space-y-5 animate-fadeIn">
              <div className="h-16 w-16 bg-amber-500/20 text-amber-400 rounded-full flex items-center justify-center border border-amber-500/50">
                <AlertTriangle className="h-8 w-8" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-amber-400 mb-2">
                  {isArabic ? "تم تأكيد حالة الخطر المحدق" : "Danger Imminent Confirmé"}
                </h3>
                <p className="text-sm text-slate-300">
                  {isArabic ? "أنت متواجد على بُعد " : "Vous êtes à "}
                  <span className="font-bold text-white px-1">{nearestThreatState?.distanceM} {isArabic ? "متر" : "mètres"}</span>
                  {nearestThreatState?.kind === "satellite"
                    ? (isArabic
                        ? "من بؤرة حرارية رصدها القمر الصناعي — لم يتأكد موقعها ميدانياً."
                        : "d'un point chaud détecté par satellite — sans confirmation sur le terrain.")
                    : (isArabic
                        ? "من حريق نشط أبلغ عنه مواطنون."
                        : "d'un feu actif signalé par des citoyens.")}
                </p>
                <p className="text-xs text-red-400 mt-2 p-2 bg-red-950/30 rounded border border-red-900/50">
                  {isArabic
                    ? "تصل استغاثتك إلى غرفة عمليات المنصة وتُعرض على فرق الاستجابة الميدانية القريبة."
                    : "Votre alerte est transmise à la salle des opérations et affichée aux unités de terrain proches."}
                </p>
              </div>

              {/* Name & Phone Info Inputs */}
              <div className="w-full space-y-3 bg-black/40 p-4 rounded-xl border border-white/5" dir={isArabic ? "rtl" : "ltr"}>
                <h4 className="text-xs font-bold text-slate-300 border-b border-white/5 pb-1.5 flex items-center gap-1.5 justify-start">
                  <span>🚨</span>
                  <span>{isArabic ? "معلومات تحديد الهوية للإنقاذ" : "Informations d'identification pour secours"}</span>
                </h4>
                <div className="space-y-1">
                  <label className="block text-[11px] font-semibold text-gray-400 text-start">
                    {isArabic ? "الاسم الكامل (اختياري)" : "Nom Complet (Optionnel)"}
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => handleNameChange(e.target.value)}
                    placeholder={isArabic ? "مثال: أحمد بوعلام" : "Ex: Ahmed Boualam"}
                    className="w-full px-3 py-2 text-xs bg-zinc-900 border border-white/10 rounded-lg text-slate-100 placeholder-gray-600 focus:outline-none focus:border-red-500/50 text-start"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-[11px] font-semibold text-gray-400 text-start">
                    {isArabic ? "رقم الهاتف للاتصال المباشر" : "Numéro de téléphone direct"}
                  </label>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => handlePhoneChange(e.target.value)}
                    placeholder={isArabic ? "مثال: 0661234567" : "Ex: 0661234567"}
                    className="w-full px-3 py-2 text-xs bg-zinc-900 border border-white/10 rounded-lg text-slate-100 placeholder-gray-600 focus:outline-none focus:border-red-500/50 text-left font-mono"
                  />
                </div>
              </div>

              {/* Siren Test Button */}
              <button
                type="button"
                onClick={playSOSTestSound}
                className={`w-full py-2.5 px-4 rounded-xl text-xs font-bold flex items-center justify-center gap-2 border transition-all cursor-pointer ${
                  isTestingSound
                    ? "bg-amber-500/20 border-amber-500 text-amber-300 animate-pulse shadow-lg shadow-amber-500/20"
                    : "bg-black/50 border-white/10 hover:border-white/20 text-gray-300 hover:text-white"
                }`}
              >
                <Volume2 className={`h-4 w-4 ${isTestingSound ? "text-amber-400 animate-bounce" : "text-gray-400"}`} />
                <span>
                  {isTestingSound
                    ? (isArabic ? "🔊 جاري تجربة صفارة الإنذار... (اضغط للإيقاف)" : "🔊 Sirène en cours d'essai...")
                    : (isArabic ? "🔊 اختبار وتجربة صوت صفارة الاستغاثة الميدانية" : "🔊 Tester le son de la sirène d'urgence")}
                </span>
              </button>

              <button
                onClick={startRecording}
                className="w-full py-4 bg-red-600 hover:bg-red-500 text-white rounded-xl font-bold flex items-center justify-center gap-2 transition-transform hover:scale-105 active:scale-95 shadow-xl cursor-pointer"
              >
                <Mic className="h-5 w-5" />
                {isArabic ? "اضغط لبدء تسجيل الاستغاثة الصوتية" : "Commencer l'enregistrement vocal"}
              </button>
            </div>
          )}

          {step === "recording" && (
            <div className="flex flex-col items-center text-center space-y-5 animate-fadeIn py-4">
              <div className="relative">
                <div className={`absolute inset-0 rounded-full animate-ping ${micStatus === "permission_denied" ? "bg-amber-500/30" : "bg-red-500/30"}`}></div>
                <div className={`h-20 w-20 rounded-full flex items-center justify-center shadow-[0_0_30px_rgba(220,38,38,0.5)] ${micStatus === "permission_denied" ? "bg-amber-600" : "bg-red-600"}`}>
                  <Mic className="h-10 w-10 text-white animate-pulse" />
                </div>
              </div>

              <div className="space-y-1">
                <h3 className="text-xl font-bold text-white font-mono">00:{recordingTime < 10 ? `0${recordingTime}` : recordingTime}</h3>
                {recordingComplete ? (
                  <p className="text-sm text-emerald-400 font-bold flex items-center justify-center gap-1">
                    <Activity className="h-4 w-4" />
                    {isArabic ? "انتهى التسجيل (20 ثانية) — اضغط لإرسال الصوت والموقع فوراً" : "Enregistrement terminé (20 s) — envoyez le message et la position"}
                  </p>
                ) : (
                  <p className="text-sm text-red-400 animate-pulse font-bold flex items-center justify-center gap-1">
                    <Activity className="h-4 w-4" />
                    {isArabic ? "تحدث الآن لتسجيل استغاثتك الصوتية المباشرة..." : "Parlez pour enregistrer votre message vocal..."}
                  </p>
                )}
                {micStatus === "permission_denied" && (
                  <p className="text-xs text-amber-300 bg-amber-950/60 p-2 rounded-lg border border-amber-500/30 font-semibold mt-2">
                    {isArabic
                      ? "⚠️ الميكروفون مغلق في متصفحك. سيتم إرسال نص الاستغاثة مع الصوت الاحتياطي."
                      : "⚠️ Micro bloqué dans votre navigateur. Un SOS textuel sera bien transmis."}
                  </p>
                )}
              </div>

              {/* Real Audio Level Visualizer */}
              <div className="flex items-end justify-center gap-1 h-12 w-full max-w-xs bg-black/60 p-2 rounded-xl border border-white/10">
                {Array.from({ length: 20 }).map((_, i) => {
                  const factor = Math.sin((i / 20) * Math.PI);
                  // Deterministic height from the (throttled) audio level —
                  // Math.random() inside render produced new bars on EVERY
                  // unrelated re-render (visual noise, wasted paint).
                  const barHeight = Math.min(100, Math.max(12, audioLevel * 1.6 * factor + 8));
                  return (
                    <div
                      key={i}
                      className={`w-2 rounded-full transition-all duration-150 ${barHeight > 60 ? "bg-red-500" : barHeight > 30 ? "bg-amber-400" : "bg-emerald-400"}`}
                      style={{ height: `${barHeight}%` }}
                    />
                  );
                })}
              </div>

              <button
                onClick={stopRecordingAndSend}
                disabled={isSending}
                className={`w-full py-4 bg-red-600 hover:bg-red-500 text-white rounded-xl font-bold flex items-center justify-center gap-2 shadow-xl shadow-red-600/30 transition-all cursor-pointer ${isSending ? "opacity-60 cursor-wait" : ""}`}
              >
                <div className="h-4 w-4 bg-white rounded-sm"></div>
                {isSending
                  ? (isArabic ? "جاري الإرسال..." : "Envoi en cours...")
                  : (isArabic ? "إنهاء التسجيل وإرسال الصوت والموقع فوراً 🚨" : "Arrêter et envoyer le SOS vocal 🚨")}
              </button>
            </div>
          )}

          {step === "send_failed" && (
            <div className="flex flex-col items-center text-center space-y-4 py-6 animate-fadeIn">
              <div className="h-16 w-16 bg-red-500/20 text-red-400 rounded-full flex items-center justify-center border border-red-500/50">
                <AlertTriangle className="h-8 w-8" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-red-400 mb-2">
                  {isArabic ? "فشل إرسال الاستغاثة!" : "Échec de l'envoi du SOS !"}
                </h3>
                <p className="text-sm text-slate-300">{sendError}</p>
              </div>
              <button
                onClick={stopRecordingAndSend}
                disabled={isSending}
                className="w-full py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl font-bold flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <RefreshCw className={`h-4 w-4 ${isSending ? "animate-spin" : ""}`} />
                {isSending ? (isArabic ? "جاري إعادة المحاولة..." : "Nouvelle tentative...") : (isArabic ? "إعادة المحاولة الآن" : "Réessayer maintenant")}
              </button>
            </div>
          )}

          {step === "sent" && (
            <div className="flex flex-col items-center text-center space-y-4 py-6 animate-fadeIn">
              <div className="h-16 w-16 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center border border-emerald-500/50 shadow-[0_0_20px_rgba(16,185,129,0.3)]">
                <ShieldCheck className="h-8 w-8" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-emerald-400 mb-2">
                  {isArabic ? "تم استلام ونشر نداء الاستغاثة!" : "SOS vocal transmis !"}
                </h3>
                <p className="text-sm text-slate-300">
                  {isArabic
                    ? "أُرسل تسجيلك الصوتي وموقعك إلى غرفة عمليات المنصة، وتُعرض استغاثتك على فرق الاستجابة القريبة."
                    : "Votre message vocal et votre position ont été envoyés à la salle des opérations et sont visibles par les unités proches."}
                </p>
              </div>

              <div className="w-full bg-slate-800/80 rounded-lg p-3 border border-slate-700 flex items-start gap-3 text-left">
                <RadioReceiver className="h-5 w-5 text-indigo-400 shrink-0 mt-0.5" />
                <p className="text-xs text-slate-400">
                  {isArabic
                    ? "نصيحة: ابق في مكان منخفض، غطِ فمك بقطعة قماش مبللة. لا تغلق هاتفك."
                    : "Conseil : Restez près du sol, couvrez votre bouche avec un tissu humide. Gardez votre téléphone allumé."}
                </p>
              </div>
              <button
                onClick={onClose}
                className="w-full mt-2 py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-lg font-bold transition-colors cursor-pointer"
              >
                {isArabic ? "إغلاق" : "Fermer"}
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
