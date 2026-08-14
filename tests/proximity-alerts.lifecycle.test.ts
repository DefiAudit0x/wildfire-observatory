import { describe, it, expect } from "vitest";
import { commitOperatorBatchAfterTone } from "../src/hooks/useProximityAlerts";

describe("operator flush transition gate", () => {
  it("does not commit a batch when trusted access is withdrawn during tone await", async () => {
    const deferred = { resolve: undefined as ((played: boolean) => void) | undefined };
    let trusted = true;
    let epoch = 0;
    let committed = false;

    const pendingCommit = commitOperatorBatchAfterTone(
      () => new Promise<boolean>((resolve) => { deferred.resolve = resolve; }),
      () => trusted,
      () => epoch,
      0,
      () => { committed = true; },
    );

    trusted = false;
    epoch = 1;
    const resolveTone = deferred.resolve;
    if (!resolveTone) throw new Error("tone resolver was not registered");
    resolveTone(true);

    expect(await pendingCommit).toBe(false);
    expect(committed).toBe(false);
  });

  it("commits when tone succeeds and the trust epoch is unchanged", async () => {
    let committed = false;
    const result = await commitOperatorBatchAfterTone(
      async () => true,
      () => true,
      () => 4,
      4,
      () => { committed = true; },
    );

    expect(result).toBe(true);
    expect(committed).toBe(true);
  });
});
