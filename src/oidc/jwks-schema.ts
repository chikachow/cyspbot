import { z } from "zod";

const baseJwkSchema = z
  .object({
    alg: z.string().min(1).optional(),
    crv: z.string().min(1).optional(),
    e: z.string().min(1).optional(),
    key_ops: z.array(z.string().min(1)).optional(),
    kid: z.string().min(1).optional(),
    kty: z.enum(["EC", "OKP", "RSA"]),
    n: z.string().min(1).optional(),
    use: z.string().min(1).optional(),
    x: z.string().min(1).optional(),
    y: z.string().min(1).optional(),
  })
  .passthrough();

export const jwksDocumentSchema = z
  .object({
    keys: z.array(baseJwkSchema).min(1),
  })
  .passthrough();

export type ParsedJwksDocument = z.infer<typeof jwksDocumentSchema>;
export type ParsedJwk = ParsedJwksDocument["keys"][number];

export interface NormalizedJwk {
  alg?: string;
  crv?: string;
  e?: string;
  kid: string | null;
  kty: "EC" | "OKP" | "RSA";
  n?: string;
  x?: string;
  y?: string;
}
