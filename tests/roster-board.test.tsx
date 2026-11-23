import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import RosterBoard from "../src/components/RosterBoard.js";

// Fix 15b: a failed roster load used to install an editable empty roster,
// and saving it after the DB recovered replaced the real day. The board must
// leave the roster unavailable (null + load error) instead.
vi.mock("../src/hooks/useAuth.js", () => ({
  useStaffSession: () => ({
    session: { authenticated: true, role: "commander", unitId: "DZ16", name: "Test", agentId: "t-commander" },
    refetch: vi.fn(),
    loading: false,
  }),
}));

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RosterBoard failed load (Fix 15b)", () => {
  it("shows a load error and keeps save disabled instead of an editable empty roster", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/roster/")) {
          return new Response(JSON.stringify({ error: "Database not available" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ users: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("تعذر تحميل الجدول.")).toBeTruthy());
    // No empty-roster hint: the board must not present a day that was never loaded.
    expect(screen.queryByText(/لا توجد مناصب مسجلة/)).toBeNull();
    // Save stays disabled while no roster is loaded.
    const saveButton = screen.getByText("حفظ جدول اليوم").closest("button");
    expect(saveButton).not.toBeNull();
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("loads and shows the saved roster when the read succeeds (control)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/roster/")) {
          return new Response(
            JSON.stringify({
              unitId: "unit-dz16",
              date: todayISO(),
              posts: [{ id: "p1", labelAr: "منصب", status: "active", personnel: [] }],
              saved: true,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ users: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب")).toBeTruthy());
    expect(screen.queryByText("تعذر تحميل الجدول.")).toBeNull();
    const saveButton = screen.getByText("حفظ جدول اليوم").closest("button");
    expect(saveButton).not.toBeNull();
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
  });

  // Fix 15c: the failed-load protection must also cover a roster that was
  // already loaded. A refetch that fails must clear it — otherwise the stale
  // day stays editable and Save re-enables once loading clears.
  it("clears a previously loaded roster when the next load returns 503", async () => {
    let rosterCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/roster/")) {
          rosterCalls += 1;
          if (rosterCalls === 1) {
            return new Response(
              JSON.stringify({
                unitId: "unit-dz16",
                date: todayISO(),
                posts: [{ id: "p1", labelAr: "منصب", status: "active", personnel: [] }],
                saved: true,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response(JSON.stringify({ error: "Database not available" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ users: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب")).toBeTruthy());
    fireEvent.click(screen.getByTitle("اليوم التالي"));
    await waitFor(() => expect(screen.getByText("تعذر تحميل الجدول.")).toBeTruthy());
    expect(screen.queryByText("منصب")).toBeNull();
    const saveButton = screen.getByText("حفظ جدول اليوم").closest("button");
    expect(saveButton).not.toBeNull();
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("clears a previously loaded roster when the next load throws", async () => {
    let rosterCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/roster/")) {
          rosterCalls += 1;
          if (rosterCalls === 1) {
            return new Response(
              JSON.stringify({
                unitId: "unit-dz16",
                date: todayISO(),
                posts: [{ id: "p1", labelAr: "منصب", status: "active", personnel: [] }],
                saved: true,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          throw new Error("network down");
        }
        return new Response(JSON.stringify({ users: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب")).toBeTruthy());
    fireEvent.click(screen.getByTitle("اليوم التالي"));
    await waitFor(() => expect(screen.getByText("تعذر تحميل الجدول.")).toBeTruthy());
    expect(screen.queryByText("منصب")).toBeNull();
    const saveButton = screen.getByText("حفظ جدول اليوم").closest("button");
    expect(saveButton).not.toBeNull();
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
  });
});

function shiftISO(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

describe("RosterBoard overlapping requests (Fix 24)", () => {
  it("a save that lands after navigating does not install day A's roster under day B (RSTR-1)", async () => {
    const dayA = todayISO();
    const dayB = shiftISO(dayA, 1);
    let releasePut!: (v: Response) => void;
    const putGate = new Promise<Response>((resolve) => {
      releasePut = resolve;
    });
    const dayAroster = {
      unitId: "unit-dz16",
      date: dayA,
      posts: [{ id: "p1", labelAr: "منصب أ", status: "active", personnel: [] }],
      saved: true,
    };
    const dayBroster = {
      unitId: "unit-dz16",
      date: dayB,
      posts: [{ id: "p2", labelAr: "منصب ب", status: "active", personnel: [] }],
      saved: true,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (String(url).includes("/api/roster/")) {
          if (method === "PUT") return putGate;
          const day = String(url).split("/api/roster/")[1];
          return new Response(JSON.stringify(day === dayB ? dayBroster : dayAroster), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ users: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب أ")).toBeTruthy());
    fireEvent.click(screen.getByText("حفظ جدول اليوم"));
    // Navigate to day B while the PUT is in flight.
    fireEvent.click(screen.getByTitle("اليوم التالي"));
    await waitFor(() => expect(screen.getByText("منصب ب")).toBeTruthy());
    // Day A's PUT finally lands.
    releasePut(
      new Response(JSON.stringify(dayAroster), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await waitFor(() => expect(screen.getByText("منصب ب")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("منصب ب")).toBeTruthy();
    expect(screen.queryByText("منصب أ")).toBeNull();
  });

  it("a save on the same day still commits (control)", async () => {
    const dayA = todayISO();
    const dayAroster = {
      unitId: "unit-dz16",
      date: dayA,
      posts: [{ id: "p1", labelAr: "منصب أ", status: "active", personnel: [] }],
      saved: true,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (String(url).includes("/api/roster/")) {
          if (method === "PUT") {
            return new Response(JSON.stringify(dayAroster), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify(dayAroster), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ users: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب أ")).toBeTruthy());
    fireEvent.click(screen.getByText("حفظ جدول اليوم"));
    await waitFor(() => expect(screen.getByText("✓ تم حفظ جدول المناوبة.")).toBeTruthy());
  });

  it("adding a post keeps unsaved edits (RSTR-2)", async () => {
    const dayA = todayISO();
    const savedDay = {
      unitId: "unit-dz16",
      date: dayA,
      posts: [
        {
          id: "p1",
          labelAr: "منصب أ",
          status: "active",
          personnel: [{ agentId: "a1", name: "عارة 1", rank: "سائق" }],
        },
      ],
      saved: true,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (String(url).includes("/api/roster/")) {
          if (method === "POST") {
            return new Response(
              JSON.stringify({ id: "p2", labelAr: "منصب ب", status: "active", personnel: [] }),
              { status: 201, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response(JSON.stringify(savedDay), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ users: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب أ")).toBeTruthy());
    // A local-only edit: change the personnel rank, do NOT save.
    const rankInput = screen.getByPlaceholderText(/الرتبة\/المهمة/) as HTMLInputElement;
    fireEvent.change(rankInput, { target: { value: "منقذ" } });
    expect(rankInput.value).toBe("منقذ");
    fireEvent.change(screen.getByPlaceholderText(/اسم المنصب/), { target: { value: "منصب ب" } });
    fireEvent.click(screen.getByText("إضافة المنصب"));
    await waitFor(() => expect(screen.getByText("منصب ب")).toBeTruthy());
    expect((screen.getByPlaceholderText(/الرتبة\/المهمة/) as HTMLInputElement).value).toBe("منقذ");
  });

  it("adding a post with no pending edits still shows it (control)", async () => {
    const dayA = todayISO();
    const savedDay = {
      unitId: "unit-dz16",
      date: dayA,
      posts: [{ id: "p1", labelAr: "منصب أ", status: "active", personnel: [] }],
      saved: true,
    };
    // The control must pass on the OLD code too: there the refetch is the
    // only way the new post appears, so the GET has to reflect the server
    // having persisted it (the POST happened) — otherwise the control
    // would fail for the wrong reason.
    let posted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (String(url).includes("/api/roster/")) {
          if (method === "POST") {
            posted = true;
            return new Response(
              JSON.stringify({ id: "p2", labelAr: "منصب ب", status: "active", personnel: [] }),
              { status: 201, headers: { "Content-Type": "application/json" } }
            );
          }
          const posts = posted
            ? [...savedDay.posts, { id: "p2", labelAr: "منصب ب", status: "active", personnel: [] }]
            : savedDay.posts;
          return new Response(JSON.stringify({ ...savedDay, posts }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ users: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب أ")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/اسم المنصب/), { target: { value: "منصب ب" } });
    fireEvent.click(screen.getByText("إضافة المنصب"));
    await waitFor(() => expect(screen.getByText("منصب ب")).toBeTruthy());
    expect(screen.getByText("منصب أ")).toBeTruthy();
  });
});

describe("RosterBoard overlapping requests (Fix 24b)", () => {
  function shiftISO(iso: string, days: number): string {
    const d = new Date(`${iso}T00:00:00`);
    d.setDate(d.getDate() + days);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  it("the Add button is disabled while the day is loading (Minor 4663970060)", async () => {
    const dayA = todayISO();
    const dayB = shiftISO(dayA, 1);
    let releaseB!: (v: Response) => void;
    const getBGate = new Promise<Response>((resolve) => {
      releaseB = resolve;
    });
    const savedDayA = {
      unitId: "unit-dz16",
      date: dayA,
      posts: [{ id: "p1", labelAr: "منصب أ", status: "active", personnel: [] }],
      saved: true,
    };
    const savedDayB = {
      unitId: "unit-dz16",
      date: dayB,
      posts: [{ id: "p1", labelAr: "منصب أ", status: "active", personnel: [] }],
      saved: true,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes(`/api/roster/${dayB}`)) return getBGate;
        if (String(url).includes("/api/roster/")) {
          return new Response(JSON.stringify(savedDayA), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ users: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب أ")).toBeTruthy());
    // Navigate to day B — its GET is gated, so the board is loading day B
    // while day A's roster is still on screen. Add must not be usable for
    // a day whose roster has not loaded (the POST would complete before
    // the GET and its merge would be silently skipped).
    fireEvent.click(screen.getByTitle("اليوم التالي"));
    await waitFor(() => {
      const addButton = screen.getByText("إضافة المنصب").closest("button");
      expect((addButton as HTMLButtonElement).disabled).toBe(true);
    });
    // Once day B lands, Add is usable again.
    releaseB(
      new Response(JSON.stringify(savedDayB), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await waitFor(() => {
      const addButton = screen.getByText("إضافة المنصب").closest("button");
      expect((addButton as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("adding a post the day GET already contains does not duplicate it (Minor 4663970069)", async () => {
    const dayA = todayISO();
    const postB = { id: "p2", labelAr: "منصب ب", status: "active", personnel: [] };
    // The GET was issued before the POST but the server processed it after
    // the POST's write, so the loaded day already contains the new post.
    const savedDay = {
      unitId: "unit-dz16",
      date: dayA,
      posts: [{ id: "p1", labelAr: "منصب أ", status: "active", personnel: [] }, postB],
      saved: true,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (String(url).includes("/api/roster/")) {
          if (method === "POST") {
            return new Response(JSON.stringify(postB), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify(savedDay), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ users: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب ب")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/اسم المنصب/), { target: { value: "منصب ب" } });
    fireEvent.click(screen.getByText("إضافة المنصب"));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getAllByText("منصب ب")).toHaveLength(1);
  });

  it("a same-day GET that lands after the add does not drop the new post (Major 4664210880)", async () => {
    const dayA = todayISO();
    const dayB = shiftISO(dayA, 1);
    let releaseGetA!: (v: Response) => void;
    const getAGate = new Promise<Response>((resolve) => {
      releaseGetA = resolve;
    });
    let releasePost!: (v: Response) => void;
    const postGate = new Promise<Response>((resolve) => {
      releasePost = resolve;
    });
    const savedDayA = {
      unitId: "unit-dz16",
      date: dayA,
      posts: [{ id: "p1", labelAr: "منصب أ", status: "active", personnel: [] }],
      saved: true,
    };
    const savedDayB = {
      unitId: "unit-dz16",
      date: dayB,
      posts: [{ id: "p1", labelAr: "منصب أ", status: "active", personnel: [] }],
      saved: true,
    };
    const postB = { id: "p2", labelAr: "منصب ب", status: "active", personnel: [] };
    let getACalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (String(url).includes("/api/roster/")) {
        if (method === "POST") return postGate;
        if (String(url).includes(`/api/roster/${dayB}`)) {
          return new Response(JSON.stringify(savedDayB), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        getACalls += 1;
        if (getACalls === 1) {
          return new Response(JSON.stringify(savedDayA), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return getAGate;
      }
      return new Response(JSON.stringify({ users: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب أ")).toBeTruthy());
    // Start the POST for day A (gated), then navigate A→B→A while it is
    // in flight: the B→A GET for day A starts during the POST.
    fireEvent.change(screen.getByPlaceholderText(/اسم المنصب/), { target: { value: "منصب ب" } });
    fireEvent.click(screen.getByText("إضافة المنصب"));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u, init]: any[]) => String(u).includes("/api/roster/") && init?.method === "POST"
        )
      ).toBe(true)
    );
    fireEvent.click(screen.getByTitle("اليوم التالي"));
    fireEvent.click(screen.getByTitle("اليوم السابق"));
    // The POST completes: the merge appends the new post locally.
    releasePost(
      new Response(JSON.stringify(postB), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    );
    await waitFor(() => expect(screen.getByText("منصب ب")).toBeTruthy());
    // The stale GET for A lands after the merge, WITHOUT the new post
    // (the server read the day before the POST committed). It must not
    // replace the merged roster — and no load error may appear either.
    releaseGetA(
      new Response(JSON.stringify(savedDayA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("منصب ب")).toBeTruthy();
    expect(screen.getByText("منصب أ")).toBeTruthy();
    expect(screen.queryByText("تعذر تحميل الجدول.")).toBeNull();
  });
});
