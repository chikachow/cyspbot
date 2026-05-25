import type { Env } from "../env.ts";
import type { GitHubApiDependencies } from "../github/http.ts";
import {
  authenticateOidcToken as defaultAuthenticateOidcToken,
  authenticateRequest as defaultAuthenticateRequest,
  type AuthenticateRequestResult,
} from "./authentication.ts";

export interface AppDependencies extends GitHubApiDependencies {
  authenticateOidcToken(
    token: string,
    request: Request,
    env: Env,
  ): Promise<AuthenticateRequestResult>;
  authenticateRequest(request: Request, env: Env): Promise<AuthenticateRequestResult>;
  now(): Date;
}

export const defaultDependencies: AppDependencies = {
  authenticateOidcToken: defaultAuthenticateOidcToken,
  authenticateRequest: defaultAuthenticateRequest,
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
};
