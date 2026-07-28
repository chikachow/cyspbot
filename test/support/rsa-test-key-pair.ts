import { generateKeyPairSync } from "node:crypto";

const testKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });

export const testPrivateKeyPem = testKeyPair.privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString();

export const testPublicJwk = {
  ...testKeyPair.publicKey.export({ format: "jwk" }),
  kid: "test-key-1",
};
