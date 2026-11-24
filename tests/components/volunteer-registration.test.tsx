// @vitest-environment jsdom
/**
 * Fix 29 (VOL-1): the volunteer form validates and sends the normalized
 * (E.164) phone — never the raw typed string. A spaced Algerian number and
 * an unprefixed 8-digit Tunisian number both used to pass the client and
 * die on the server's schema.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import VolunteerRegistration from "../../src/components/VolunteerRegistration";

const WILAYA_VALUE = "الجزائر - أدرار (Algérie - Adrar)";

function fillForm(phone: string, wilayaValue: string = WILAYA_VALUE) {
  render(<VolunteerRegistration lang="fr" />);
  fireEvent.change(screen.getByPlaceholderText(/Nom complet/), { target: { value: "Amina Benali" } });
  fireEvent.change(screen.getByPlaceholderText(/Téléphone/), { target: { value: phone } });
  const selects = document.querySelectorAll("select");
  fireEvent.change(selects[1], { target: { value: wilayaValue } });
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: /Soumettre/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("VolunteerRegistration phone (Fix 29 VOL-1)", () => {
  it("sends the normalized E.164 phone for a spaced Algerian number", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    fillForm("0550 123 456");
    submit();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.phone).toBe("+213550123456");
  });

  it("sends the normalized E.164 phone for an 8-digit Tunisian number", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    fillForm("23456789");
    submit();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.phone).toBe("+21623456789");
  });

  it("does not fetch for an invalid phone and shows the validation error", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fillForm("aaaaaa");
    submit();
    await waitFor(() => expect(screen.getByText(/Numéro invalide/)).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("VolunteerRegistration ceiling + country hint (Fix 39)", () => {
  it("the registration rides apiFetch's 15 s ceiling (the issued fetch carries an AbortSignal)", async () => {
    const fetchMock = vi.fn().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    fillForm("0550123456");
    submit();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Fix 33 precedent: fake timers do NOT fire AbortSignal.timeout, so the
    // signal's presence — not a timed abort — is the proof of the ceiling.
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("a Moroccan wilaya sends the Moroccan prefix for a bare 06 number", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    fillForm("0612345678", "المغرب - طنجة تطوان الحسيمة (Maroc - Tanger-Tétouan-Al Hoceïma)");
    submit();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.phone).toBe("+212612345678");
  });
});
