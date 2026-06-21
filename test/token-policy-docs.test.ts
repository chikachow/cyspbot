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
      expect(documentation).not.toContain(rule.principalRepository);
      expect(documentation).not.toContain(rule.principalWorkflowRef);
      expect(documentation).not.toContain(rule.resource);
    }
  });

  it("does not claim raw sub strings are exact rule criteria", () => {
    const documentation = documentationText();

    expect(documentation).not.toContain("`sub`, `ref`, and `workflow_ref` exactly match");
    expect(documentation).not.toContain("`repository`, `ref`, `sub`, and `workflow_ref`");
    expect(documentation).toContain("parsed subject ref");
  });

  it("does not describe cross-owner token requests as unsupported", () => {
    expect(documentationText()).not.toContain("cross-owner token requests");
  });

  it("documents the name-based repository identity boundary", () => {
    const documentation = documentationText();

    expect(documentation).toContain("owner/repository names");
    expect(documentation).toContain("deleted and recreated");
  });

  it("does not overclaim repository ID-bound policy semantics", () => {
    const documentation = documentationText();

    expect(documentation).not.toContain(
      "the parsed subject repository is consistent with the `repository`, `repository_id`, and `repository_owner_id` claims",
    );
    expect(documentation).toContain("authenticated principal facts, not policy keys");
  });
});

function documentationText(): string {
  return [implementationDoc, serviceContractDoc, docsReadmeDoc, readmeDoc].join("\n");
}
