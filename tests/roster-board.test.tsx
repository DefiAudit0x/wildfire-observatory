import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import RosterBoard from "../src/components/RosterBoard.js";

const staffSession = vi.hoisted(() => ({ authenticated: true, role: "commander", unitId: "DZ16", name: "Test", agentId: "t-commander" }));

// Fix 15b: a failed roster load used to install an editable empty roster,
// and saving it after the DB recovered replaced the real day. The board must
// leave the roster unavailable (null + load error) instead.
vi.mock("../src/hooks/useAuth.js", () => ({
  useStaffSession: () => ({
    session: staffSession,
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
  staffSession.role = "commander";
  staffSession.unitId = "DZ16";
  staffSession.agentId = "t-commander";
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

  it("an add that lands while another day is on screen refetches the selected day (Major 4664428918)", async () => {
    const dayA = todayISO();
    const dayB = shiftISO(dayA, 1);
    let releasePost!: (v: Response) => void;
    const postGate = new Promise<Response>((resolve) => {
      releasePost = resolve;
    });
    let releaseGetB!: (v: Response) => void;
    const getBGate = new Promise<Response>((resolve) => {
      releaseGetB = resolve;
    });
    let releaseGetAStale!: (v: Response) => void;
    const getAStaleGate = new Promise<Response>((resolve) => {
      releaseGetAStale = resolve;
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
      posts: [{ id: "p1", labelAr: "منصب الغد", status: "active", personnel: [] }],
      saved: true,
    };
    const postB = { id: "p2", labelAr: "منصب ب", status: "active", personnel: [] };
    const savedDayAWithPost = {
      unitId: "unit-dz16",
      date: dayA,
      posts: [
        { id: "p1", labelAr: "منصب أ", status: "active", personnel: [] },
        postB,
      ],
      saved: true,
    };
    let getACalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (String(url).includes("/api/roster/")) {
        if (method === "POST") return postGate;
        if (String(url).includes(`/api/roster/${dayB}`)) return getBGate;
        getACalls += 1;
        if (getACalls === 1) {
          return new Response(JSON.stringify(savedDayA), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (getACalls === 2) return getAStaleGate;
        // The 24d refetch: a fresh GET for A, read post-commit.
        return new Response(JSON.stringify(savedDayAWithPost), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ users: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب أ")).toBeTruthy());
    // Start the POST for day A (gated), navigate to B and let B LOAD,
    // then return to A (A's GET now in flight).
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
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]: any[]) => String(u).includes(`/api/roster/${dayB}`))).toBe(true)
    );
    releaseGetB(
      new Response(JSON.stringify(savedDayB), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await waitFor(() => expect(screen.getByText("منصب الغد")).toBeTruthy());
    fireEvent.click(screen.getByTitle("اليوم السابق"));
    await waitFor(() => expect(getACalls).toBe(2));
    // The POST completes while the LIVE roster is B's: the merge cannot
    // apply, so the board must refetch day A (fresh, post-commit) instead
    // of killing A's GET and getting stuck on B's roster under A's header.
    releasePost(
      new Response(JSON.stringify(postB), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    );
    await waitFor(() => expect(screen.getByText("منصب ب")).toBeTruthy());
    expect(screen.queryByText("منصب الغد")).toBeNull();
    expect(screen.getByText("منصب أ")).toBeTruthy();
    // The stale GET for A lands after the fresh load, WITHOUT the new
    // post — it must be ignored, not reinstall the day without the post.
    releaseGetAStale(
      new Response(JSON.stringify(savedDayA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("منصب ب")).toBeTruthy();
    expect(screen.queryByText("تعذر تحميل الجدول.")).toBeNull();
  });
});

describe("RosterBoard rank clear and assignment filter (Fix 37 — RSTR-3/RSTR-4)", () => {
  const mixedUsers = [
    { agentId: "a1", name: "Agent One", role: "agent", unitId: "DZ16", isActive: true },
    { agentId: "c1", name: "Commander One", role: "commander", unitId: "DZ16", isActive: true },
    { agentId: "a2", name: "Agent Two", role: "agent", unitId: "DZ01", isActive: true },
    { agentId: "a3", name: "Agent Three", role: "agent", unitId: "DZ16", isActive: false },
    // Fix 37b: a raw "unit-dz16" code is REJECTED server-side
    // (toUnitId("unit-dz16") = "unit-unit-dz16" !== "unit-dz16") — the
    // Fix 37 strip-both-sides comparison wrongly offered this account.
    { agentId: "a5", name: "Agent Five", role: "agent", unitId: "unit-dz16", isActive: true },
  ];
  const dayWithRank = {
    unitId: "unit-dz16",
    date: todayISO(),
    posts: [{ id: "p1", labelAr: "منصب", status: "active", personnel: [{ agentId: "a1", name: "Agent One", rank: "سائق" }] }],
    saved: true,
  };
  const emptyDay = {
    unitId: "unit-dz16",
    date: todayISO(),
    posts: [{ id: "p1", labelAr: "منصب", status: "active", personnel: [] }],
    saved: true,
  };

  // The stub simulates the server's zod rank rule: a present-but-empty rank
  // 400s, an omitted rank saves fine. PUT bodies are recorded for assertion;
  // a successful PUT echoes the saved posts back (as the server would).
  function installStub(roster: unknown, users: unknown[]) {
    const putBodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/api/roster/") && init?.method === "PUT") {
          const body = JSON.parse(String(init.body));
          putBodies.push(body);
          const ranks = (body.posts as any[]).flatMap((p) => p.personnel.map((x: any) => x.rank));
          if (ranks.some((r: unknown) => r === "")) {
            return new Response(JSON.stringify({ error: "Validation failed" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(
            JSON.stringify({ unitId: "unit-dz16", date: todayISO(), posts: body.posts, saved: true }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (String(url).includes("/api/roster/")) {
          return new Response(JSON.stringify(roster), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (String(url).includes("/api/users")) {
          return new Response(JSON.stringify({ users }), {
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
    return { putBodies };
  }

  it("clearing a rank omits it from the save instead of 400ing and reloading the day", async () => {
    const { putBodies } = installStub(dayWithRank, mixedUsers);
    render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب")).toBeTruthy());
    const rankInput = screen.getByPlaceholderText(/الرتبة/) as HTMLInputElement;
    expect(rankInput.value).toBe("سائق");
    fireEvent.change(rankInput, { target: { value: "" } });
    fireEvent.click(screen.getByText("حفظ جدول اليوم"));
    await waitFor(() => expect(screen.getByText("✓ تم حفظ جدول المناوبة.")).toBeTruthy());
    expect(putBodies.length).toBe(1);
    const person = putBodies[0].posts[0].personnel[0];
    expect("rank" in person).toBe(false);
    expect((screen.getByPlaceholderText(/الرتبة/) as HTMLInputElement).value).toBe("");
  });

  it("a present rank is still saved (control)", async () => {
    const { putBodies } = installStub(dayWithRank, mixedUsers);
    render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب")).toBeTruthy());
    fireEvent.click(screen.getByText("حفظ جدول اليوم"));
    await waitFor(() => expect(screen.getByText("✓ تم حفظ جدول المناوبة.")).toBeTruthy());
    expect(putBodies[0].posts[0].personnel[0].rank).toBe("سائق");
  });

  it("the assignment selector offers only same-unit agents", async () => {
    installStub(emptyDay, mixedUsers);
    render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب")).toBeTruthy());
    // The staff load resolves after the roster: wait for the offered option.
    await waitFor(() => expect(screen.queryByText("Agent One (a1)")).toBeTruthy());
    expect(screen.queryByText("Commander One (c1)")).toBeNull();
    expect(screen.queryByText("Agent Two (a2)")).toBeNull();
    // Inactive accounts were already filtered by fetchStaff — pinned here too.
    expect(screen.queryByText("Agent Three (a3)")).toBeNull();
    // Fix 37b: a raw "unit-dz16" code is rejected server-side, so it must
    // not be offered either (the Fix 37 comparison stripped the prefix on
    // both sides and offered it).
    expect(screen.queryByText("Agent Five (a5)")).toBeNull();
  });

  it("a raw UNIT-DZ16 code is offered when the roster is unit-unit-dz16 (Fix 37b)", async () => {
    // The server accepts this pair: toUnitId("UNIT-DZ16") = "unit-unit-dz16".
    // The Fix 37 comparison stripped both sides ("dz16" vs "unit-dz16")
    // and hid the eligible agent.
    const unitUnitDay = {
      unitId: "unit-unit-dz16",
      date: todayISO(),
      posts: [{ id: "p1", labelAr: "منصب", status: "active", personnel: [] }],
      saved: true,
    };
    const unitUsers = [{ agentId: "a4", name: "Agent Four", role: "agent", unitId: "UNIT-DZ16", isActive: true }];
    installStub(unitUnitDay, unitUsers);
    render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب")).toBeTruthy());
    await waitFor(() => expect(screen.queryByText("Agent Four (a4)")).toBeTruthy());
  });

  it("the offered same-unit agent can be added and saved (control)", async () => {
    const { putBodies } = installStub(emptyDay, mixedUsers);
    render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب")).toBeTruthy());
    await waitFor(() => expect(screen.queryByText("Agent One (a1)")).toBeTruthy());
    const select = screen.getByText("+ أضف مناوباً إلى هذا المنصب").closest("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "a1" } });
    await waitFor(() => expect(screen.queryByText(/Agent One \(a1\) — موزع/)).toBeTruthy());
    fireEvent.click(screen.getByText("حفظ جدول اليوم"));
    await waitFor(() => expect(screen.getByText("✓ تم حفظ جدول المناوبة.")).toBeTruthy());
    expect(putBodies[0].posts[0].personnel[0].agentId).toBe("a1");
  });
});


describe("Round 2 roster unit selection", () => {
  it("F007: a unitless global admin defaults to an available unit and can save its roster", async () => {
    staffSession.role = "admin";
    staffSession.unitId = "";
    const roster = { unitId: "unit-dz16", date: todayISO(), saved: true, posts: [] };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = url === "/api/units" ? { units: [{ code: "DZ16", nameAr: "وحدة", nameFr: "Unité" }] }
        : url.includes("/api/roster/") && url.endsWith("?unit=DZ16") ? roster : { users: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RosterBoard lang="fr" />);
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Unité" }) as HTMLSelectElement).value).toBe("DZ16"));
    const save = screen.getByRole("button", { name: /Enregistrer/i });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("?unit=DZ16") && init?.method === "PUT")).toBe(true));
  });
});

describe("RosterBoard identity change (CodeRabbit PR #215, R2-#3)", () => {
  function rosterResponse(label: string) {
    return new Response(
      JSON.stringify({
        unitId: "unit-dz16",
        date: todayISO(),
        posts: [{ id: "p1", labelAr: label, status: "active", personnel: [] }],
        saved: true,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  it("clears the old commander's roster and loads the new commander's roster when the session identity changes", async () => {
    let rosterCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/roster/")) {
          rosterCalls += 1;
          return rosterResponse(rosterCalls === 1 ? "منصب أ" : "منصب ب");
        }
        return new Response(JSON.stringify({ users: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    const { rerender } = render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب أ")).toBeTruthy());
    expect(rosterCalls).toBe(1);
    // A different commander signs in (same unit, same role) — e.g. in
    // another tab, picked up by the shared session poll. `authenticated`
    // stays true and unitQuery stays "" for both, so without the fix no
    // reload happens and commander A's roster stays rendered.
    staffSession.agentId = "t-commander-2";
    rerender(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب ب")).toBeTruthy());
    expect(screen.queryByText("منصب أ")).toBeNull();
    expect(rosterCalls).toBe(2);
  });

  it("does not install a save response issued under the previous identity", async () => {
    let rosterCalls = 0;
    let resolvePut!: (value: Response) => void;
    const putPromise = new Promise<Response>((resolve) => {
      resolvePut = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: any) => {
        if (String(url).includes("/api/roster/")) {
          if (init?.method === "PUT") return putPromise;
          rosterCalls += 1;
          return rosterResponse(rosterCalls === 1 ? "منصب أ" : "منصب ب");
        }
        return new Response(JSON.stringify({ users: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    const { rerender } = render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب أ")).toBeTruthy());
    // Start a save under commander A.
    fireEvent.click(screen.getByText("حفظ جدول اليوم"));
    // While the PUT is in flight, commander B signs in.
    staffSession.agentId = "t-commander-2";
    rerender(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب ب")).toBeTruthy());
    // The PUT now lands with commander A's response — it must be discarded,
    // not installed over commander B's board.
    resolvePut(rosterResponse("منصب محفوظ"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByText("منصب محفوظ")).toBeNull();
    expect(screen.getByText("منصب ب")).toBeTruthy();
  });

  it("does not surface a save failure from the previous identity", async () => {
    let rosterCalls = 0;
    let rejectPut!: (err: Error) => void;
    const putPromise = new Promise<Response>((_resolve, reject) => {
      rejectPut = reject;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: any) => {
        if (String(url).includes("/api/roster/")) {
          if (init?.method === "PUT") return putPromise;
          rosterCalls += 1;
          return rosterResponse(rosterCalls === 1 ? "منصب أ" : "منصب ب");
        }
        return new Response(JSON.stringify({ users: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    const { rerender } = render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب أ")).toBeTruthy());
    fireEvent.click(screen.getByText("حفظ جدول اليوم"));
    staffSession.agentId = "t-commander-2";
    rerender(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب ب")).toBeTruthy());
    rejectPut(new Error("network down"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByText("تعذر حفظ الجدول.")).toBeNull();
    expect(screen.getByText("منصب ب")).toBeTruthy();
  });
});

describe("RosterBoard logout timeout (CodeRabbit PR #215, R2-#4)", () => {
  it("logout rides the 15 s apiFetch ceiling", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: any) => {
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
      if (String(url).includes("/logout")) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ users: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RosterBoard lang="ar" />);
    await waitFor(() => expect(screen.getByText("منصب")).toBeTruthy());
    fireEvent.click(screen.getByText("خروج"));
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/logout"));
      expect(calls.length).toBe(2);
    });
    // apiFetch passes an AbortSignal.timeout(15_000); bare fetch() passes
    // no signal at all, so these assertions fail on the pre-fix code.
    const logoutCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/logout"));
    expect(logoutCalls.map(([url]) => String(url)).sort()).toEqual([
      "/api/admin/logout",
      "/api/auth/logout",
    ]);
    for (const [, init] of logoutCalls) {
      expect((init as any)?.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
