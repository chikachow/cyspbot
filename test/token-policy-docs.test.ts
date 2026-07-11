import { describe, expect, it } from "vitest";

import { tokenPolicyRules as productionTokenPolicyRules } from "@cyspbot/token-exchange/policy/token-policy-rules";
import readmeDoc from "../README.md?raw";
import implementationDoc from "../docs/implementation.md?raw";
import docsReadmeDoc from "../docs/README.md?raw";
import serviceContractDoc from "../docs/service-contract.md?raw";

describe("Token Policy documentation contract", () => {
  it("does not document exact production policy entries", () => {
    const documentation = documentationText();

    for (const rule of productionTokenPolicyRules) {
      expect(documentation).not.toContain(rule.id);
      expect(documentation).not.toContain(rule.issue.githubInstallationToken.resource);
      expect(documentation).not.toContain(rule.when);
    }
  });

  it("documents generic verified subject-token policy evaluation", () => {
    const documentation = documentationText();

    expect(documentation).toContain("subject_token");
    expect(documentation).toContain("CEL");
    expect(documentation).toContain("claims");
  });

  it("documents how Google service-account callers acquire a compatible token", () => {
    expect(readmeDoc).toContain("generateIdToken");
    expect(readmeDoc).toContain('"audience": "cyspbot"');
    expect(readmeDoc).toContain('"includeEmail": false');
    expect(readmeDoc).toContain('{"includeEmail": true}');
    expect(readmeDoc).toContain("Google token-generation `audience`");
    expect(readmeDoc).toContain("https://api.github.com/repos/{owner}/{repo}");
  });
});

function documentationText(): string {
  return [implementationDoc, serviceContractDoc, docsReadmeDoc, readmeDoc].join("\n");
}
