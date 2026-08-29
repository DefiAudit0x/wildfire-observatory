import { describe, expect, it } from "vitest";
import {
  createPublicPrincipalToken,
  verifyPublicPrincipalToken,
} from "../server/public-principal.js";
import { createMeshToken, verifyMeshToken } from "../server/mesh-auth.js";

describe("server-issued public principals", () => {
  it("creates a verifiable principal with a server-defined subject", () => {
    const token = createPublicPrincipalToken("principal-a", "credential-a");
    expect(verifyPublicPrincipalToken(token)).toMatchObject({
      scope: "public-principal",
      subject: "principal-a",
      jti: "credential-a",
    });
  });

  it("binds mesh tokens to the principal subject rather than a caller-selected device id", () => {
    const token = createMeshToken("principal-a");
    const payload = verifyMeshToken(token);
    expect(payload).toEqual({ scope: "mesh", subject: "principal-a" });
    expect(payload).not.toHaveProperty("deviceId");
  });

  it("does not accept a public-principal token as a mesh token", () => {
    const principalToken = createPublicPrincipalToken("principal-a", "credential-a");
    expect(verifyMeshToken(principalToken)).toBeNull();
  });
});
