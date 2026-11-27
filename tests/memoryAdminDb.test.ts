import { describe, expect, it } from "vitest";
import { memoryAdminDb } from "./helpers/memoryAdminDb";

// CodeRabbit (PR #215, finding 14): runTransaction used to apply each
// queued write directly to the shared docs map, so a write that threw
// partway left the earlier writes applied — real Firestore transactions
// never partially apply. These tests pin the staged-then-publish behaviour.
describe("memoryAdminDb transaction atomicity", () => {
  it("a failed transaction applies none of its writes", async () => {
    const docs = new Map<string, Record<string, unknown>>();
    docs.set("reports/existing", { status: "pending" });
    const db = memoryAdminDb(docs);
    const reports = db.collection("reports");

    await expect(
      db.runTransaction(async (tx) => {
        tx.create(reports.doc("new"), { status: "pending" });
        tx.create(reports.doc("existing"), { status: "verified" });
      }),
    ).rejects.toThrow("Document already exists");

    // The first write must NOT have leaked: the new document stays absent
    // and the pre-existing document stays exactly as it was.
    expect(docs.has("reports/new")).toBe(false);
    expect(docs.get("reports/existing")).toEqual({ status: "pending" });
  });

  it("a successful transaction publishes all of its writes", async () => {
    const docs = new Map<string, Record<string, unknown>>();
    docs.set("reports/existing", { status: "pending" });
    const db = memoryAdminDb(docs);
    const reports = db.collection("reports");

    await db.runTransaction(async (tx) => {
      tx.create(reports.doc("new"), { status: "pending" });
      tx.update(reports.doc("existing"), { status: "verified" });
    });

    expect(docs.get("reports/new")).toEqual({ status: "pending" });
    expect(docs.get("reports/existing")).toEqual({ status: "verified" });
  });
});
