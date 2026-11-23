import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import SafeZonesManager from "../../src/components/admin/SafeZonesManager";
import { useLiveEvents } from "../../src/utils/live";

vi.mock("../../src/utils/live", () => ({ useLiveEvents: vi.fn() }));

interface Zone {
  id: string;
  nameAr: string;
  nameFr: string;
  capacity: number;
  lat: number;
  lng: number;
  hasMedical: boolean;
  isActive?: boolean;
}

const zoneA: Zone = {
  id: "zone-a",
  nameAr: "مركز أ",
  nameFr: "Centre A",
  capacity: 1000,
  lat: 36.81,
  lng: 7.61,
  hasMedical: true,
  isActive: true,
};

const zoneB: Zone = {
  id: "zone-b",
  nameAr: "مركز ب",
  nameFr: "Centre B",
  capacity: 500,
  lat: 36.82,
  lng: 7.62,
  hasMedical: false,
  isActive: false,
};

function capturedLiveHandler() {
  // The mock accumulates calls across tests in the file — the current
  // render's handler is the LAST call, not the first (an earlier test's
  // handler belongs to an unmounted component).
  const calls = (useLiveEvents as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  // Fix 26 review (Nit N2): on old code the component never subscribes,
  // so the calls list is empty — fail with a self-describing error instead
  // of a bare TypeError from indexing an empty array.
  if (calls.length === 0) {
    throw new Error("useLiveEvents was never called — the component does not subscribe to live events");
  }
  return calls[calls.length - 1][0] as (event: { ts: number; type: string }) => void;
}

describe("SafeZonesManager admin endpoint (Fix 26 — SZM-1)", () => {
  let zonesData: Zone[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    zonesData = [zoneA, zoneB];
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/safezones/admin") {
        return new Response(JSON.stringify(zonesData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/safezones/zone-b" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        zonesData = zonesData.map((z) => (z.id === "zone-b" ? { ...z, ...body } : z));
        return new Response(JSON.stringify(zonesData[1]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function renderManager() {
    render(<SafeZonesManager lang="ar" onAuthError={() => false} />);
    await screen.findByText("مركز ب");
  }

  const adminCalls = () =>
    fetchMock.mock.calls.filter((c) => (c as unknown[])[0] === "/api/safezones/admin").length;
  const publicCalls = () =>
    fetchMock.mock.calls.filter((c) => (c as unknown[])[0] === "/api/safezones").length;

  it("loads from the admin endpoint and shows the inactive row with its reactivation toggle", async () => {
    await renderManager();
    expect(adminCalls()).toBe(1);
    expect(publicCalls()).toBe(0);
    expect(screen.getByText("مُعطّل")).toBeTruthy();
    // The "inactive" filter selects the deactivated record.
    const select = screen.getByDisplayValue("كل الحالات");
    await act(async () => {
      fireEvent.change(select, { target: { value: "inactive" } });
    });
    expect(screen.getByText("مركز ب")).toBeTruthy();
    expect(screen.queryByText("مركز أ")).toBeNull();
  });

  it("toggling an inactive zone reactivates it via PUT and refetches the admin list", async () => {
    await renderManager();
    const toggle = screen.getByText("مُعطّل");
    await act(async () => {
      fireEvent.click(toggle);
    });
    // Both zones are active now, so both toggles read "نشط" — and the
    // "مُعطّل" label is gone entirely.
    await act(async () => {
      await screen.findAllByRole("button", { name: "نشط" });
    });
    expect(screen.getAllByRole("button", { name: "نشط" })).toHaveLength(2);
    expect(screen.queryByText("مُعطّل")).toBeNull();
    const put = fetchMock.mock.calls.find(
      (c) => (c as unknown[])[0] === "/api/safezones/zone-b"
    ) as unknown[] | undefined;
    expect(put).toBeTruthy();
    const putInit = (put as unknown[])[1] as { body?: string };
    expect(JSON.parse(String(putInit.body))).toMatchObject({
      isActive: true,
    });
    expect(adminCalls()).toBe(2);
  });

  it("a live safezones:changed event refetches the admin list", async () => {
    await renderManager();
    expect(adminCalls()).toBe(1);
    await act(async () => {
      capturedLiveHandler()({ ts: Date.now(), type: "safezones:changed" });
    });
    expect(adminCalls()).toBe(2);
  });

  it("an older overlapping GET never overwrites a newer list or clears loading early (watch Major 4666538050)", async () => {
    await renderManager();
    expect(adminCalls()).toBe(1);
    // Two overlapping admin GETs, resolved out of order.
    const deferreds: { resolve: (res: Response) => void }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/safezones/admin") {
          return new Promise<Response>((resolve) => {
            deferreds.push({ resolve });
          });
        }
        return new Response("{}", { status: 404 });
      })
    );
    await act(async () => {
      capturedLiveHandler()({ ts: Date.now(), type: "safezones:changed" });
      capturedLiveHandler()({ ts: Date.now(), type: "safezones:changed" });
    });
    expect(deferreds).toHaveLength(2);
    const renamedA = { ...zoneA, nameAr: "مركز أ المعدّل" };
    // The OLDER response lands first, with a renamed zone A.
    await act(async () => {
      deferreds[0].resolve(
        new Response(JSON.stringify([renamedA, zoneB]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    });
    // The older response is discarded: no renamed row, and the refresh
    // button is still disabled (loading not cleared while the newer GET
    // is in flight).
    expect(screen.queryByText("مركز أ المعدّل")).toBeNull();
    expect(document.querySelectorAll("button[disabled]").length).toBeGreaterThan(0);
    // The NEWER response lands: zone B removed.
    await act(async () => {
      deferreds[1].resolve(
        new Response(JSON.stringify([zoneA]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    });
    expect(screen.queryByText("مركز ب")).toBeNull();
    expect(screen.getByText("مركز أ")).toBeTruthy();
    expect(document.querySelectorAll("button[disabled]").length).toBe(0);
  });

  it("a slow older response body never overwrites a newer list (watch Minor 4666879313)", async () => {
    await renderManager();
    expect(adminCalls()).toBe(1);
    // The older GET's headers arrive first but its body stays pending while
    // the newer GET completes — the 26b seq check before res.json() cannot
    // see this interleave, so the check must also run after the parse.
    let olderJsonResolve: (v: Zone[]) => void = () => {};
    const olderJson = new Promise<Zone[]>((resolve) => {
      olderJsonResolve = resolve;
    });
    let adminCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/safezones/admin") {
          adminCallCount += 1;
          if (adminCallCount === 1) {
            // Older request: headers now, body deferred.
            return { ok: true, json: () => olderJson } as unknown as Response;
          }
          // Newer request: body already buffered.
          return new Response(JSON.stringify([zoneA]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 404 });
      })
    );
    const renamedA = { ...zoneA, nameAr: "مركز أ المعدّل" };
    await act(async () => {
      capturedLiveHandler()({ ts: Date.now(), type: "safezones:changed" });
    });
    // Let the older request pass its pre-parse seq check (no newer request
    // has started yet), then start the newer request and let it finish.
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      capturedLiveHandler()({ ts: Date.now(), type: "safezones:changed" });
    });
    await act(async () => {});
    expect(screen.queryByText("مركز ب")).toBeNull();
    expect(screen.getByText("مركز أ")).toBeTruthy();
    // Now the older body finally arrives — it must not overwrite.
    await act(async () => {
      olderJsonResolve([renamedA, zoneB]);
    });
    expect(screen.queryByText("مركز أ المعدّل")).toBeNull();
    expect(screen.queryByText("مركز ب")).toBeNull();
    expect(screen.getByText("مركز أ")).toBeTruthy();
  });
});
