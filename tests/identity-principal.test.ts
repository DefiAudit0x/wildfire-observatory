import { describe, expect, it } from "vitest";
import {
  createPublicPrincipalToken,
  verifyPublicPrincipalToken,
} from "../server/public-principal.js";
import { createMeshToken, verifyMeshToken } from "../server/mesh-auth.js";

describe("server-issued public principals", () => {
  // The principal subject is server-issued and always a UUID (randomUUID),
  // which is exactly what the createPublicPrincipalToken signature encodes.
  const SUBJECT_A = "3f2b8a1c-4d5e-4f60-9a7b-8c0d1e2f3a4b";
  const CREDENTIAL_A = "0b8dfc5a-1d2b-4c8e-9f60-3a7e5b2c1d00";

  it("creates a verifiable principal with a server-defined subject", () => {
    const token = createPublicPrincipalToken(SUBJECT_A, CREDENTIAL_A);
    expect(verifyPublicPrincipalToken(token)).toMatchObject({
      scope: "public-principal",
      subject: SUBJECT_A,
      jti: CREDENTIAL_A,
    });
  });

  it("binds mesh tokens to the principal subject rather than a caller-selected device id", () => {
    const token = createMeshToken(SUBJECT_A);
    // jwt.verify returns iat/exp alongside the payload — assert the fields
    // that matter instead of strict deep equality.
    expect(verifyMeshToken(token)).toMatchObject({ scope: "mesh", subject: SUBJECT_A });
    expect(verifyMeshToken(token)).not.toHaveProperty("deviceId");
  });

  it("does not accept a public-principal token as a mesh token", () => {
    const principalToken = createPublicPrincipalToken(SUBJECT_A, CREDENTIAL_A);
    expect(verifyMeshToken(principalToken)).toBeNull();
  });
});
