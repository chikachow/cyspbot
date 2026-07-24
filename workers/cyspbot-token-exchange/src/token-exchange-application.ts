import type { GitHubAppEnv } from "@cyspbot/github/app";
import type { TokenPolicy } from "./policy/token-policy.ts";

export interface TokenExchangeApplication {
  readonly githubApp: GitHubAppEnv;
  readonly tokenPolicy: TokenPolicy;
}
