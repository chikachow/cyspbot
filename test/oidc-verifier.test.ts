import { createPrivateKey } from "node:crypto";

import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

import type { IssuerRegistration } from "../src/oidc/principals.ts";
import { verifyOidcToken } from "../src/oidc/verify-oidc-token.ts";
import { emptyVerifierState, registrationFingerprint } from "../src/oidc/verifier-state.ts";

const testPrivateKeyPem = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC27Vu1+aKPooBG
8zJHy9cbx0FAO26Fk2HnzYpl/Tm7POL6Pxzht2HO6GOTEv7OKz7o0TzG6XdDz5ci
+IP6eKHVPPRupH7wbYOqxp4zRhPMaVaaJFQ27ApXANOKxz+UBjGe/JMFQaTA/O3k
NJ0WoNXlMUDDWlLzmkz767EmqkrOeDO+/I11BSw3r07Kheu1C5LZ/Bv/IE1JINsV
NzzN4cVHXmI9HXkLAHwDzeUs0cu7ar6Vxfl4ON5lDptwKptntfU4nn7p1zZK9q0Q
QVjPRVwhaLy+XofSoO57xf5euJyYDxa9T3iqAZO1WZ7kXHIZUY6Mrws6NVmbt2cp
BM77ECyLAgMBAAECggEAA3x4j/pG99fP/AosfiPLYLMmcjPvwknxxrorFhCCZigd
50kGouKc0ZWqOCZXhtRaKZO7RcszQ66UIc18rmxYITk9K1KlPK3JoZqRb0a5n96u
ENf6ZuWOuOPCJFXxxz9q+K21m5cJrcfkPMIn8EN2cBzFMDPressJBpASWztJm6+0
g6uTBt6l9CU3ObvjyORefXSfPwkhGKNfvgy75/VSlddcDAV+wjH14JdqWdMlntHH
fMRPboYC3cvik6YsWb6qNGfjXz+Hzeba7D13y+QGYWrdfBfavbTHqkgZKas7AmyY
Tdrl1VlWD+h03Tec3DkhIxrdeA1+Wf+wmBjonmURSQKBgQDgrpsNIe8Ee/TT7VMz
4fb3GfplRv0lshPfYW5W4ULEga2Oviz32BtSPhgG6NFZwIJ+MTxQhvPwGMQuYfqR
CR3SG9O+m+kr4CLJJLxQ0RHBQ9VtP9wVOKqUiNkE9ez7mqx3/RF8oenNUPkAUFso
1O0d9p87H5xpGZ43NVupfGpL1wKBgQDQbM0rYOK+1YToh7RanFLW0MpvQcvQHjsF
qJ56yoza0f/3FNyrEy7vcwzI5m+mQLfRMLkrvljv+iavjylG2cZDr+/lK4QQRcyM
LQctBJeSXw/y2+dS7AvL5XJQkRe8hpZTpFNdVsOnzWrqEl674CrFZKo89ORIirLJ
7GJJgZTubQKBgQDF2FrGNKRREYnj9+41GHws2N5Jwjn1sJqZMCVGMbNmcD5RHJti
XxSn1e+4XdjDLKZ70oUm777sJBLUOQi4IAv3UPOiu42WSha3gjak/4Sf50iPnBUD
RtPGWb6oBJn6cBgAzIJSegzz86JfqWKsUNq/cMSD/nDvh1Rvjve5BcpgHwKBgAKi
7bF3x0Z8svKyDMD8qzuWZokjvu1CBKMcr+yDtWZrM56vf98WHgjfXrEH4S+sL+cQ
g7ce8EcQ1f5whCgmRxDCH/m5JDGEgILhau7R2Qz78Nq0l2eAHuIUY+7K9w7mcO5b
7MYIe+8adRjC5LnhqwjWLiUZP+3++yX8vH2LixO9AoGATPqMHTEaIrIh999ahqmv
OulHU1mIPsNEzbagWNwCmDJB5+MJPE76j59Gg1NMVmRQvDOnhktjCdyr7cLoSyb5
cT0XqIpKa8tyk2RAMjqM52QwttVzRnDjhqrpyM+9HsPyP7huvTlkpwLBE8GR7cP3
guigOK0SOM7v+1ceZuh/bm8=
-----END PRIVATE KEY-----
`;

async function createToken(kid: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const privateKey = createPrivateKey(testPrivateKeyPem);

  return new SignJWT({
    actor: "dependabot[bot]",
    event_name: "workflow_dispatch",
    repository: "cysp/terraform-provider-contentful",
    repository_id: "123456789",
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setAudience("cyspbot")
    .setIssuer("https://token.actions.githubusercontent.com")
    .setIssuedAt(now - 10)
    .setNotBefore(now - 10)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

describe("verifyOidcToken", () => {
  it("performs only one guarded refresh for an unknown kid miss", async () => {
    const registration: IssuerRegistration = {
      allowedAlgorithms: ["RS256"],
      audience: "cyspbot",
      defaultFreshMs: 5 * 60 * 1000,
      issuer: "https://token.actions.githubusercontent.com",
      jwksUri: "https://jwks.example.test",
      mapPrincipal: () => null,
      maxBackoffMs: 5 * 60 * 1000,
      maxFreshMs: 15 * 60 * 1000,
      minFreshMs: 60 * 1000,
      principalKind: "github-actions",
      refreshBackoffBaseMs: 5 * 1000,
      requireKid: true,
      source: "remote-jwks",
      staleWhileErrorMs: 10 * 60 * 1000,
    };
    const token = await createToken("missing-key");
    const nowMs = Date.now();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          keys: [
            {
              e: "AQAB",
              kid: "other-key",
              kty: "RSA",
              n: "tu1btfmij6KARvMyR8vXG8dBQDtuhZNh582KZf05uzzi-j8c4bdhzuhjkxL-zis-6NE8xul3Q8-XIviD-nih1Tz0bqR-8G2DqsaeM0YTzGlWmiRUNuwKVwDTisc_lAYxnvyTBUGkwPzt5DSdFqDV5TFAw1pS85pM--uxJqpKzngzvvyNdQUsN69OyoXrtQuS2fwb_yBNSSDbFTc8zeHFR15iPR15CwB8A83lLNHLu2q-lcX5eDjeZQ6bcCqbZ7X1OJ5-6dc2SvatEEFYz0VcIWi8vl6H0qDue8X-XricmA8WvU94qgGTtVme5FxyGVGOjK8LOjVZm7dnKQTO-xAsiw",
              x5c: ["extra-standard-field"],
            },
          ],
        }),
        {
          headers: {
            "cache-control": "max-age=300",
            "content-type": "application/json",
          },
          status: 200,
        },
      );
    });
    const state = {
      ...emptyVerifierState(registrationFingerprint(registration)),
      snapshot: {
        fetchedAtMs: nowMs,
        freshUntilMs: nowMs + 60_000,
        keys: [
          {
            e: "AQAB",
            kid: "old-key",
            kty: "RSA" as const,
            n: "tu1btfmij6KARvMyR8vXG8dBQDtuhZNh582KZf05uzzi-j8c4bdhzuhjkxL-zis-6NE8xul3Q8-XIviD-nih1Tz0bqR-8G2DqsaeM0YTzGlWmiRUNuwKVwDTisc_lAYxnvyTBUGkwPzt5DSdFqDV5TFAw1pS85pM--uxJqpKzngzvvyNdQUsN69OyoXrtQuS2fwb_yBNSSDbFTc8zeHFR15iPR15CwB8A83lLNHLu2q-lcX5eDjeZQ6bcCqbZ7X1OJ5-6dc2SvatEEFYz0VcIWi8vl6H0qDue8X-XricmA8WvU94qgGTtVme5FxyGVGOjK8LOjVZm7dnKQTO-xAsiw",
          },
        ],
        staleUntilMs: nowMs + 120_000,
      },
    };

    const verification = await verifyOidcToken(
      token,
      registration,
      state,
      { now: () => nowMs },
      fetchImpl,
      new Map(),
    );

    expect(verification.result).toMatchObject({
      ok: false,
      reason: "no_matching_key",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
