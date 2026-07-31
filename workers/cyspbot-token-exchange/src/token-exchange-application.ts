import type { GitHubAppEnv } from "@cyspbot/github/app";
import type { TokenIssuancePolicy } from "./policy/token-issuance-policy.ts";

export interface TokenExchangeApplication {
  readonly githubApp: GitHubAppEnv;
  readonly tokenIssuancePolicy: TokenIssuancePolicy;
}
