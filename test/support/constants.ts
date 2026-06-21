import { generateKeyPairSync } from "node:crypto";

const testKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });

export const testPrivateKeyPem = testKeyPair.privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString();

export const testPublicJwk = {
  ...testKeyPair.publicKey.export({ format: "jwk" }),
  kid: "test-key-1",
};

export const tokenExchangeGrantType = "urn:ietf:params:oauth:grant-type:token-exchange";
export const githubInstallationAccessTokenType =
  "urn:chikachow:github-app-installation-access-token";
export const oidcIdTokenType = "urn:ietf:params:oauth:token-type:id_token";
export const testRepository = "fixture-owner/fixture-source-repository";
export const testRepositoryId = "123456789";
export const testWorkflowDispatchRepository = "fixture-target-owner/fixture-target-repository";
export const testWorkflowDispatchRepositoryId = "987654321";
export const testInstallationId = 67890;
export const testWorkflowDispatchInstallationId = 98765;
export const testRepositoryOwnerId = "555555";
export const testRepositoryVisibility = "private";
export const testNow = new Date("2026-05-24T00:00:00.000Z");
