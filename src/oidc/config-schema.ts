import { z } from "zod";

export const rawIssuerRegistrationSchema = z
  .object({
    allowedAlgorithms: z.array(z.string().min(1)).min(1),
    audience: z.string().min(1),
    defaultFreshMs: z.number().int().positive(),
    issuer: z.string().url(),
    jwksUri: z.string().url(),
    maxBackoffMs: z.number().int().positive(),
    maxFreshMs: z.number().int().positive(),
    minFreshMs: z.number().int().positive(),
    principalKind: z.literal("github-actions"),
    refreshBackoffBaseMs: z.number().int().positive(),
    requireKid: z.boolean(),
    staleWhileErrorMs: z.number().int().positive(),
  })
  .superRefine((value, ctx) => {
    if (value.minFreshMs > value.defaultFreshMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "minFreshMs must be <= defaultFreshMs",
        path: ["minFreshMs"],
      });
    }

    if (value.defaultFreshMs > value.maxFreshMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "defaultFreshMs must be <= maxFreshMs",
        path: ["defaultFreshMs"],
      });
    }
  });

export const rawIssuerRegistrationsSchema = z
  .array(rawIssuerRegistrationSchema)
  .min(1)
  .superRefine((value, ctx) => {
    const seen = new Set<string>();

    for (const [index, registration] of value.entries()) {
      if (seen.has(registration.issuer)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "issuer must be unique",
          path: [index, "issuer"],
        });
        continue;
      }

      seen.add(registration.issuer);
    }
  });

export const testStaticPublicKeyOverrideSchema = z.object({
  keyId: z.string().min(1).nullable(),
  publicKeyPemBase64: z.string().min(1),
});

export type RawIssuerRegistration = z.infer<typeof rawIssuerRegistrationSchema>;
export type TestStaticPublicKeyOverride = z.infer<typeof testStaticPublicKeyOverrideSchema>;
