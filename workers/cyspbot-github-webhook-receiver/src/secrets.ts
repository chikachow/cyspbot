export type SecretTextBinding = string | SecretsStoreSecret;

export async function resolveSecretText(
  binding: SecretTextBinding | undefined,
): Promise<string | undefined> {
  if (binding === undefined || typeof binding === "string") {
    return binding;
  }

  const value: unknown = await binding.get();
  if (typeof value !== "string") {
    throw new TypeError("Webhook secret binding must return a string.");
  }
  return value;
}
