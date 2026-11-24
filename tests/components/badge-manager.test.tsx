import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import BadgeManager from "../../src/components/admin/BadgeManager.js";

const badgeWithLimits = {
  code: "VOL-001",
  ownerName: "مختبر",
  type: "volunteer",
  wilaya: "عنابة",
  maxUses: 5,
  expiresAt: "2030-06-01T00:00:00.000Z",
  usedCount: 0,
  isActive: true,
};

const badgeNoLimits = {
  code: "VOL-002",
  ownerName: "بدون حدود",
  type: "volunteer",
  wilaya: "عنابة",
  usedCount: 0,
  isActive: true,
};

const analytics = {
  total: 1,
  active: 1,
  inactive: 0,
  expired: 0,
  capReached: 0,
  totalUsage: 0,
  byType: { volunteer: 1 },
  byWilaya: { "عنابة": 1 },
  topUsed: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(badges: unknown[]) {
  const putBodies: Record<string, unknown>[] = [];
  const postBodies: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method || "GET";
    if (String(url).includes("/api/badges/analytics")) {
      return new Response(JSON.stringify(analytics), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (String(url).includes("/api/badges/") && method === "PUT") {
      putBodies.push(JSON.parse(init?.body || "{}") as Record<string, unknown>);
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (String(url).endsWith("/api/badges") && method === "POST") {
      postBodies.push(JSON.parse(init?.body || "{}") as Record<string, unknown>);
      return new Response(JSON.stringify({}), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    if (String(url).includes("/api/badges")) {
      return new Response(JSON.stringify(badges), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 404, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { putBodies, postBodies };
}

async function openEditForm(code: string) {
  await waitFor(() => expect(screen.getByText(code)).toBeTruthy());
  fireEvent.click(screen.getByTitle("تعديل"));
  const saveButton = screen.getByText("حفظ");
  const form = saveButton.closest("form");
  if (!form) throw new Error("edit form not found");
  return form;
}

describe("BadgeManager clear limits (Fix 33 — BDG-1)", () => {
  it("clearing the expiry sends an explicit empty-string clear, and the untouched cap stays a number", async () => {
    const { putBodies } = stubFetch([badgeWithLimits]);
    render(<BadgeManager lang="ar" onAuthError={() => false} />);
    const form = await openEditForm("VOL-001");
    const expiryInput = form.querySelector('input[type="datetime-local"]');
    if (!expiryInput) throw new Error("expiry input not found in edit form");
    fireEvent.change(expiryInput, { target: { value: "" } });
    fireEvent.click(screen.getByText("حفظ"));
    await waitFor(() => expect(putBodies.length).toBe(1));
    expect("expiresAt" in putBodies[0]).toBe(true);
    expect(putBodies[0].expiresAt).toBe("");
    expect(putBodies[0].maxUses).toBe(5);
  });

  it("clearing the cap sends an explicit null clear, and the untouched expiry stays an ISO string", async () => {
    const { putBodies } = stubFetch([badgeWithLimits]);
    render(<BadgeManager lang="ar" onAuthError={() => false} />);
    const form = await openEditForm("VOL-001");
    const capInput = form.querySelector('input[type="number"]');
    if (!capInput) throw new Error("cap input not found in edit form");
    fireEvent.change(capInput, { target: { value: "" } });
    fireEvent.click(screen.getByText("حفظ"));
    await waitFor(() => expect(putBodies.length).toBe(1));
    expect("maxUses" in putBodies[0]).toBe(true);
    expect(putBodies[0].maxUses).toBeNull();
    expect(typeof putBodies[0].expiresAt).toBe("string");
  });

  it("untouched empty fields stay omitted (control)", async () => {
    const { putBodies } = stubFetch([badgeNoLimits]);
    render(<BadgeManager lang="ar" onAuthError={() => false} />);
    const form = await openEditForm("VOL-002");
    const nameInput = form.querySelector('input[placeholder="اسم الحامل"]');
    if (!nameInput) throw new Error("owner name input not found in edit form");
    fireEvent.change(nameInput, { target: { value: "اسم جديد" } });
    fireEvent.click(screen.getByText("حفظ"));
    await waitFor(() => expect(putBodies.length).toBe(1));
    expect("maxUses" in putBodies[0]).toBe(false);
    expect("expiresAt" in putBodies[0]).toBe(false);
    expect(putBodies[0].ownerName).toBe("اسم جديد");
  });

  it("create with empty optionals omits both keys (control — the server nulls them)", async () => {
    const { postBodies } = stubFetch([]);
    render(<BadgeManager lang="ar" onAuthError={() => false} />);
    await waitFor(() => expect(screen.getByText("لا توجد بادجات بعد.")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("الرمز (مثال VOL-001)"), { target: { value: "VOL-009" } });
    fireEvent.change(screen.getByPlaceholderText("اسم الحامل"), { target: { value: "جديد" } });
    fireEvent.change(screen.getByPlaceholderText("الولاية المقيدة"), { target: { value: "عنابة" } });
    fireEvent.click(screen.getByText("إنشاء"));
    await waitFor(() => expect(postBodies.length).toBe(1));
    expect("maxUses" in postBodies[0]).toBe(false);
    expect("expiresAt" in postBodies[0]).toBe(false);
    expect(postBodies[0].code).toBe("VOL-009");
  });
});
