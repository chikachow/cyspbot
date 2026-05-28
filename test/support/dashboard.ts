import { expect } from "vitest";

import { cookieHeaderValue, fetchWorker, responseSetCookies, workerEnv } from "./worker.ts";

export async function createDashboardSessionCookie(): Promise<string> {
  await workerEnv.DB.prepare(
    `
      UPDATE dashboard_users
      SET session_revoked_after = NULL
      WHERE github_user_id = ?
    `,
  )
    .bind("42")
    .run();

  const loginResponse = await fetchWorker("https://example.test/login/github", {
    redirect: "manual",
  });
  expect(loginResponse.status).toBe(302);
  const stateCookie = responseSetCookies(loginResponse)[0];
  expect(stateCookie).toBeDefined();
  expect(stateCookie).toContain("__Host-cyspbot_oauth_state=");
  const authorizeUrl = new URL(loginResponse.headers.get("location") ?? "https://example.test");
  const state = authorizeUrl.searchParams.get("state");
  expect(state).not.toBeNull();

  const callbackResponse = await fetchWorker(
    `https://example.test/auth/github/callback?code=test-dashboard-code&state=${encodeURIComponent(state ?? "")}`,
    {
      headers: {
        cookie: cookieHeaderValue(stateCookie!),
      },
      redirect: "manual",
    },
  );
  expect(callbackResponse.status).toBe(302);
  expect(callbackResponse.headers.get("location")).toBe("/dashboard");
  const sessionCookie = responseSetCookies(callbackResponse).find((cookie) =>
    cookie.startsWith("__Host-cyspbot_dashboard_session="),
  );
  expect(sessionCookie).toBeDefined();

  return sessionCookie!;
}
