import { describe, expect, it, vi } from "vitest";

type StoredDoc = Record<string, unknown>;

type FakeState = {
  docs: Map<string, StoredDoc>;
  queue: Promise<void>;
  failNextTransaction: boolean;
};

const state = vi.hoisted<FakeState>(() => ({ docs: new Map(), queue: Promise.resolve(), failNextTransaction: false }));

vi.mock("../server/firebase.js", () => ({
  getDb: () => createAdminDb(),
  isAdminDb: () => true,
}));

function key(collection: string, id: string): string {
  return `${collection}/${id}`;
}

function snapshotFor(path: string) {
  const data = state.docs.get(path);
  return {
    exists: Boolean(data),
    id: path.split("/").at(-1),
    data: () => data,
  };
}

function createAdminDb() {
  return {
    collection(collectionName: string) {
      return {
        doc(id: string) {
          const path = key(collectionName, id);
          return {
            id,
            get: async () => snapshotFor(path),
            path,
          };
        },
        where(field: string, operator: string, value: unknown) {
          return {
            limit(count: number) {
              return { kind: "query", collectionName, field, operator, value, count };
            },
          };
        },
      };
    },
    async runTransaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
      const previous = state.queue;
      let release!: () => void;
      state.queue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const writes: Array<{ kind: "create" | "update"; path: string; data: StoredDoc }> = [];
      if (state.failNextTransaction) {
        state.failNextTransaction = false;
        throw new Error("simulated transaction failure before commit");
      }
      const tx = {
        get: async (ref: { path?: string; kind?: string; collectionName?: string; field?: string; value?: unknown; count?: number }) => {
          if (ref.kind === "query") {
            const matches = [...state.docs.entries()]
              .filter(([path, data]) => path.startsWith(`${ref.collectionName}/`) && data[ref.field!] === ref.value)
              .slice(0, ref.count ?? 2)
              .map(([path, data]) => ({ id: path.split("/").at(-1), data: () => data }));
            return { size: matches.length, empty: matches.length === 0, docs: matches };
          }
          return snapshotFor(ref.path!);
        },
        create: (ref: { path: string }, data: StoredDoc) => writes.push({ kind: "create", path: ref.path, data }),
        update: (ref: { path: string }, data: StoredDoc) => writes.push({ kind: "update", path: ref.path, data }),
      };
      try {
        const result = await callback(tx);
        for (const write of writes) {
          state.docs.set(write.path, write.kind === "update"
            ? { ...state.docs.get(write.path), ...write.data }
            : write.data);
        }
        return result;
      } finally {
        release();
      }
    },
  };
}

const { saveReportWithIdempotency } = await import("../server/db.js");

function report(clientGeneratedId: string, id: string) {
  return {
    id,
    clientGeneratedId,
    lat: 36.75,
    lng: 7.6,
    locationName: "Atomic test location",
    wilaya: "الجزائر - عنابة (Algérie - Annaba)",
    description: "بلاغ اختبار transaction الذرية",
    severity: "medium",
    reporterType: "citizen",
    timestamp: new Date().toISOString(),
  };
}

function badgeTrust(code: string, baseReport: ReturnType<typeof report>) {
  return {
    code,
    reporterType: "official" as const,
    wilaya: baseReport.wilaya,
    trustedReport: { ...baseReport, status: "verified", consensusCount: 10 },
  };
}

describe("durable report idempotency transaction", () => {
  it("converges concurrent first submissions to one durable report", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    const id = "cg-atomic-concurrent-0001";
    const [first, second] = await Promise.all([
      saveReportWithIdempotency(report(id, "rep-atomic-a"), "sha256-fingerprint-a", () => ""),
      saveReportWithIdempotency(report(id, "rep-atomic-b"), "sha256-fingerprint-a", () => ""),
    ]);

    expect([first.status, second.status].sort()).toEqual(["existing", "saved"]);
    const savedResult = first.status === "saved" ? first : second;
    expect(savedResult.status).toBe("saved");
    if (savedResult.status !== "saved") throw new Error("expected one concurrent transaction to save");
    expect([...state.docs.keys()]).toEqual([
      `reports/${savedResult.report.id}`,
      `reportIdempotency/${id}`,
    ]);
  });

  it("normalizes undefined only in the Firestore persistence copy", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    const id = "cg-persistence-normalization-0001";
    const original = {
      ...report(id, "rep-persistence-normalization"),
      image: undefined,
      aiVerification: { confidence: 99, optionalReason: undefined },
    };
    const fingerprint = "sha256-before-persistence-normalization";

    const result = await saveReportWithIdempotency(original, fingerprint, () => "");

    expect(result).toMatchObject({ status: "saved", report: { id: original.id, image: undefined } });
    const persisted = state.docs.get(`reports/${original.id}`) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("image");
    expect(persisted.aiVerification).toEqual({ confidence: 99 });
    expect(state.docs.get(`reportIdempotency/${id}`)).toMatchObject({ fingerprint, reportId: original.id });
  });

  it("backfills exactly one legacy report inside the transaction", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    const id = "cg-legacy-one-0001";
    const legacy = report(id, "rep-legacy-one");
    state.docs.set(`reports/${legacy.id}`, legacy);
    const canonical = (value: any) => `${value.description}|${value.severity}`;

    const result = await saveReportWithIdempotency(legacy, canonical(legacy), canonical);

    expect(result).toMatchObject({ status: "existing", report: { id: legacy.id } });
    expect(state.docs.get(`reportIdempotency/${id}`)).toMatchObject({ reportId: legacy.id });
    expect([...state.docs.keys()].filter((path) => path.startsWith("reports/"))).toEqual([`reports/${legacy.id}`]);
  });

  it("rejects a legacy report with a different canonical fingerprint without binding", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    const id = "cg-legacy-mismatch-0001";
    const legacy = report(id, "rep-legacy-mismatch");
    state.docs.set(`reports/${legacy.id}`, legacy);
    const canonical = (value: any) => `${value.description}|${value.severity}`;

    const result = await saveReportWithIdempotency(
      { ...legacy, description: "different canonical body" },
      "different-fingerprint",
      canonical,
    );

    expect(result).toMatchObject({ status: "same_id_different_body", report: { id: legacy.id } });
    expect(state.docs.has(`reportIdempotency/${id}`)).toBe(false);
    expect(state.docs.has("reports/rep-legacy-mismatch-replacement")).toBe(false);
  });

  it("returns integrity failure for duplicate legacy reports without writing a third report or key", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    const id = "cg-legacy-duplicate-0001";
    state.docs.set("reports/legacy-a", report(id, "legacy-a"));
    state.docs.set("reports/legacy-b", report(id, "legacy-b"));

    const result = await saveReportWithIdempotency(report(id, "rep-legacy-new"), "legacy-fingerprint", () => "");

    expect(result).toEqual({ status: "integrity_failure" });
    expect(state.docs.has(`reportIdempotency/${id}`)).toBe(false);
    expect(state.docs.has("reports/rep-legacy-new")).toBe(false);
  });

  it("concurrent retries against one legacy report bind one key and create no duplicate", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    const id = "cg-legacy-concurrent-0001";
    const legacy = report(id, "rep-legacy-concurrent");
    state.docs.set(`reports/${legacy.id}`, legacy);
    const canonical = (value: any) => `${value.description}|${value.severity}`;

    const [first, second] = await Promise.all([
      saveReportWithIdempotency(legacy, canonical(legacy), canonical),
      saveReportWithIdempotency(legacy, canonical(legacy), canonical),
    ]);

    expect(first.status).toBe("existing");
    expect(second.status).toBe("existing");
    expect(state.docs.get(`reportIdempotency/${id}`)).toMatchObject({ reportId: legacy.id });
    expect([...state.docs.keys()].filter((path) => path.startsWith("reports/"))).toEqual([`reports/${legacy.id}`]);
  });

  it("does not leave an orphan report or key when the transaction fails before commit", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    state.failNextTransaction = true;
    const id = "cg-legacy-crash-0001";
    const newReport = report(id, "rep-legacy-crash");

    const result = await saveReportWithIdempotency(newReport, "crash-fingerprint", () => "");

    expect(result).toEqual({ status: "error" });
    expect(state.docs.has(`reports/${newReport.id}`)).toBe(false);
    expect(state.docs.has(`reportIdempotency/${id}`)).toBe(false);
  });

  it("classifies same ID with a different canonical fingerprint without overwriting", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    const id = "cg-atomic-mismatch-0001";
    const original = report(id, "rep-atomic-original");
    const initial = await saveReportWithIdempotency(original, "sha256-original", () => "");
    expect(initial.status).toBe("saved");
    if (initial.status !== "saved") throw new Error("expected initial transaction to save");

    await expect(saveReportWithIdempotency(report(id, "rep-atomic-replacement"), "sha256-different", () => ""))
      .resolves.toMatchObject({ status: "same_id_different_body", report: { id: initial.report.id } });

    expect(state.docs.get(`reports/${original.id}`)).toEqual(original);
    expect(state.docs.has(`reports/rep-atomic-replacement`)).toBe(false);
  });

  it("grants the final badge use to only one concurrent new report", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    state.docs.set("badgeCodes/OFFICIAL-LAST-USE", {
      isActive: true,
      type: "official",
      wilaya: "الجزائر - عنابة (Algérie - Annaba)",
      usedCount: 0,
      maxUses: 1,
    });
    const firstReport = { ...report("cg-badge-concurrent-0001", "rep-badge-concurrent-a"), reporterType: "official", status: "pending", consensusCount: 1 };
    const secondReport = { ...report("cg-badge-concurrent-0002", "rep-badge-concurrent-b"), reporterType: "official", status: "pending", consensusCount: 1 };

    const [first, second] = await Promise.all([
      saveReportWithIdempotency(firstReport, "badge-fingerprint-a", () => "", badgeTrust("OFFICIAL-LAST-USE", firstReport)),
      saveReportWithIdempotency(secondReport, "badge-fingerprint-b", () => "", badgeTrust("OFFICIAL-LAST-USE", secondReport)),
    ]);

    expect(first.status).toBe("saved");
    expect(second.status).toBe("saved");
    if (first.status !== "saved" || second.status !== "saved") throw new Error("expected both reports to be saved");
    expect([first.report.status, second.report.status].sort()).toEqual(["pending", "verified"]);
    expect([first.report.consensusCount, second.report.consensusCount].sort()).toEqual([1, 10]);
    expect(state.docs.get("badgeCodes/OFFICIAL-LAST-USE")?.usedCount).toBe(1);
  });

  it("does not consume another badge use for an idempotent retry", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    state.docs.set("badgeCodes/OFFICIAL-IDEMPOTENT", {
      isActive: true,
      type: "official",
      usedCount: 0,
      maxUses: 2,
    });
    const original = report("cg-badge-idempotent-0001", "rep-badge-idempotent-a");
    const trust = badgeTrust("OFFICIAL-IDEMPOTENT", original);

    const first = await saveReportWithIdempotency(original, "badge-idempotent-fingerprint", () => "", trust);
    const retry = await saveReportWithIdempotency(
      report(original.clientGeneratedId, "rep-badge-idempotent-b"),
      "badge-idempotent-fingerprint",
      () => "",
      trust,
    );

    expect(first.status).toBe("saved");
    expect(retry.status).toBe("existing");
    expect(state.docs.get("badgeCodes/OFFICIAL-IDEMPOTENT")?.usedCount).toBe(1);
  });

  it("does not consume a badge use when the report transaction fails", async () => {
    state.docs.clear();
    state.queue = Promise.resolve();
    state.failNextTransaction = true;
    state.docs.set("badgeCodes/OFFICIAL-TRANSACTION-FAILURE", {
      isActive: true,
      type: "official",
      usedCount: 0,
      maxUses: 1,
    });
    const newReport = report("cg-badge-transaction-failure", "rep-badge-transaction-failure");

    await expect(saveReportWithIdempotency(
      newReport,
      "badge-transaction-failure-fingerprint",
      () => "",
      badgeTrust("OFFICIAL-TRANSACTION-FAILURE", newReport),
    )).resolves.toEqual({ status: "error" });

    expect(state.docs.get("badgeCodes/OFFICIAL-TRANSACTION-FAILURE")?.usedCount).toBe(0);
    expect(state.docs.has(`reports/${newReport.id}`)).toBe(false);
  });
});
