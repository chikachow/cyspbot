import { CelScalar, celEnv, mapType, parse, plan, type CelInput } from "@bufbuild/cel";
import type { VerifiedSubjectToken } from "../authentication.ts";
import type { TokenPolicyRuleDefinition } from "./token-policy.ts";

const tokenPolicyCelEnv = celEnv({
  variables: {
    claims: mapType(CelScalar.STRING, CelScalar.DYN),
  },
});
const compiledTokenPolicyRules = new WeakMap<TokenPolicyRuleDefinition, CompiledTokenPolicyRule>();

interface CompiledTokenPolicyRule {
  evaluate(bindings: Record<string, CelInput>): unknown;
}

export function tokenPolicyConditionIsValid(rule: TokenPolicyRuleDefinition): boolean {
  return compileTokenPolicyRule(rule) !== null;
}

export function tokenPolicyConditionMatches(
  rule: TokenPolicyRuleDefinition,
  verifiedSubjectToken: VerifiedSubjectToken,
): boolean {
  try {
    const compiledRule = compileTokenPolicyRule(rule);

    return compiledRule?.evaluate(tokenPolicyCelBindings(verifiedSubjectToken)) === true;
  } catch {
    return false;
  }
}

function compileTokenPolicyRule(rule: TokenPolicyRuleDefinition): CompiledTokenPolicyRule | null {
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

function tokenPolicyCelBindings(
  verifiedSubjectToken: VerifiedSubjectToken,
): Record<string, CelInput> {
  return {
    claims: verifiedSubjectToken.claims as Record<string, CelInput>,
  };
}
