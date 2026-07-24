import { CelScalar, celEnv, mapType, parse, plan, type CelInput } from "@bufbuild/cel";
import type { VerifiedSubjectToken } from "../authentication.ts";
import type { TokenPolicyRule } from "./token-policy.ts";

const tokenPolicyCelEnv = celEnv({
  variables: {
    claims: mapType(CelScalar.STRING, CelScalar.DYN),
    subject: mapType(CelScalar.STRING, CelScalar.DYN),
  },
});
const compiledTokenPolicyRules = new WeakMap<TokenPolicyRule, CompiledTokenPolicyRule>();

interface CompiledTokenPolicyRule {
  evaluate(bindings: Record<string, CelInput>): unknown;
}

export function tokenPolicyConditionIsValid(rule: TokenPolicyRule): boolean {
  return compileTokenPolicyRule(rule) !== null;
}

export function tokenPolicyConditionMatches(
  rule: TokenPolicyRule,
  subjectToken: VerifiedSubjectToken,
): boolean {
  try {
    const compiledRule = compileTokenPolicyRule(rule);

    return compiledRule?.evaluate(tokenPolicyCelBindings(subjectToken)) === true;
  } catch {
    return false;
  }
}

function compileTokenPolicyRule(rule: TokenPolicyRule): CompiledTokenPolicyRule | null {
  const compiledRule = compiledTokenPolicyRules.get(rule);

  if (compiledRule !== undefined) {
    return compiledRule;
  }

  try {
    const newCompiledRule = {
      evaluate: plan(tokenPolicyCelEnv, parse(rule.when)),
    };

    compiledTokenPolicyRules.set(rule, newCompiledRule);

    return newCompiledRule;
  } catch {
    return null;
  }
}

function tokenPolicyCelBindings(subjectToken: VerifiedSubjectToken): Record<string, CelInput> {
  const claims = subjectToken.claims as Record<string, CelInput>;

  return {
    claims,
    subject: {
      claims,
      issuer: subjectToken.issuer,
      resolvedKeyId: subjectToken.resolvedKeyId,
      subjectTokenType: subjectToken.subjectTokenType,
    },
  };
}
