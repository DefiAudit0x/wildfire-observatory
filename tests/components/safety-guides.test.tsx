// Fix 31 — GDE-1 (arrow navigation must move focus with the selection) and
// GDE-2 (speech must stop when the guide unmounts or its content changes).
// Speech stubs copy the Fix 26b pattern (safe-evacuation.test.tsx:242-253).
import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import SafetyGuides from "../../src/components/SafetyGuides";

const speakMock = vi.fn();
const cancelMock = vi.fn();
// Captures every utterance the component creates, so tests can assert on
// the language it chose without asserting on jsdom's innerText fidelity,
// and can fire a superseded utterance's late events (Fix 31b).
const utterances: {
  text: string;
  lang: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  utterances.length = 0;
  vi.stubGlobal("speechSynthesis", { speak: speakMock, cancel: cancelMock });
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      text: string;
      lang = "";
      rate = 1;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text: string) {
        this.text = text;
        utterances.push(
          this as unknown as {
            text: string;
            lang: string;
            onend: (() => void) | null;
            onerror: (() => void) | null;
          }
        );
      }
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const readButtonAr = () => screen.getByRole("button", { name: "قراءة الدليل بصوت عالٍ" });
const readButtonFr = () => screen.getByRole("button", { name: "Lire à voix haute" });

describe("SafetyGuides keyboard navigation (Fix 31 — GDE-1)", () => {
  it("two Rights from the first tab reach the third tab and move focus with the selection", () => {
    render(<SafetyGuides lang="ar" />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(4);
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tabs[1], { key: "ArrowRight" });
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[2]);
  });

  it("ArrowLeft from the first tab wraps to the last tab and moves focus there", () => {
    render(<SafetyGuides lang="ar" />);
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(tabs[3].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[3]);
  });

  it("Home returns to the first tab with focus; End jumps to the last tab with focus", () => {
    render(<SafetyGuides lang="ar" />);
    const tabs = screen.getAllByRole("tab");
    tabs[2].focus();
    fireEvent.keyDown(tabs[2], { key: "End" });
    expect(tabs[3].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[3]);
    fireEvent.keyDown(tabs[3], { key: "Home" });
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[0]);
  });

  it("clicking a tab still selects it (control)", () => {
    render(<SafetyGuides lang="ar" />);
    const tabs = screen.getAllByRole("tab");
    fireEvent.click(tabs[2]);
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");
  });
});

describe("SafetyGuides read-aloud lifecycle (Fix 31 — GDE-2)", () => {
  it("a tab change stops speech and resets the toggle so the next click reads the new tab", () => {
    render(<SafetyGuides lang="ar" />);
    fireEvent.click(readButtonAr());
    expect(speakMock).toHaveBeenCalledTimes(1);
    const tabs = screen.getAllByRole("tab");
    fireEvent.click(tabs[1]);
    expect(cancelMock).toHaveBeenCalled();
    // On old code the second click would cancel instead of speaking, so
    // speak would stay at 1.
    fireEvent.click(readButtonAr());
    expect(speakMock).toHaveBeenCalledTimes(2);
  });

  it("a language change stops speech and the next read uses the new language", () => {
    const { rerender } = render(<SafetyGuides lang="ar" />);
    fireEvent.click(readButtonAr());
    expect(speakMock).toHaveBeenCalledTimes(1);
    expect(utterances[0].lang).toBe("ar-DZ");
    rerender(<SafetyGuides lang="fr" />);
    expect(cancelMock).toHaveBeenCalled();
    fireEvent.click(readButtonFr());
    expect(speakMock).toHaveBeenCalledTimes(2);
    expect(utterances[1].lang).toBe("fr-FR");
  });

  it("unmounting stops speech", () => {
    const { unmount } = render(<SafetyGuides lang="ar" />);
    fireEvent.click(readButtonAr());
    expect(speakMock).toHaveBeenCalledTimes(1);
    unmount();
    expect(cancelMock).toHaveBeenCalled();
  });

  it("clicking read twice with no change speaks then cancels (control)", () => {
    render(<SafetyGuides lang="ar" />);
    fireEvent.click(readButtonAr());
    expect(speakMock).toHaveBeenCalledTimes(1);
    fireEvent.click(readButtonAr());
    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(speakMock).toHaveBeenCalledTimes(1);
  });

  it("mounting under StrictMode does not cancel speech this guide never started (Fix 31b)", () => {
    // The app runs under StrictMode (main.tsx:68), whose simulated unmount
    // runs the unmount cleanup on mount. With no guide utterance in
    // progress the cleanup must not touch speechSynthesis at all.
    render(
      <StrictMode>
        <SafetyGuides lang="ar" />
      </StrictMode>
    );
    expect(cancelMock).not.toHaveBeenCalled();
    expect(speakMock).not.toHaveBeenCalled();
  });

  it("a late error from a superseded utterance does not flip the toggle while a new read plays (Fix 31b)", () => {
    render(<SafetyGuides lang="ar" />);
    // Read tab A, then switch tabs (cancels A), then read again (B).
    fireEvent.click(readButtonAr());
    expect(speakMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole("tab")[1]);
    expect(cancelMock).toHaveBeenCalledTimes(1);
    fireEvent.click(readButtonAr());
    expect(speakMock).toHaveBeenCalledTimes(2);
    // A's error fires late, after B started. On old code it flips
    // `speaking` false; the next click would then speak instead of stop.
    // The invocation MUST be wrapped in act: a bare call schedules the
    // state update but it never flushes before the next click's handler
    // reads `speaking` from its closure, so the test would pass vacuously
    // on old code (proven by probe: bare call → click cancels on old code).
    act(() => {
      utterances[0].onerror?.();
    });
    fireEvent.click(readButtonAr());
    expect(speakMock).toHaveBeenCalledTimes(2);
    expect(cancelMock).toHaveBeenCalledTimes(2);
  });
});
