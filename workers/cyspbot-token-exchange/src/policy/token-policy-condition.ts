import { CelScalar, celEnv, mapType, parse, plan, type CelInput } from "@bufbuild/cel";
import type { TokenPolicyInput, TokenPolicyRule } from "./token-policy.ts";

const tokenPolicyCelEnv = celEnv({
  variables: {
    claims: mapType(CelScalar.STRING, CelScalar.DYN),
    request: mapType(CelScalar.STRING, CelScalar.DYN),
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
  input: TokenPolicyInput,
): boolean {
  try {
    const compiledRule = compileTokenPolicyRule(rule);

    return compiledRule?.evaluate(tokenPolicyCelBindings(input)) === true;
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

function tokenPolicyCelBindings(input: TokenPolicyInput): Record<string, CelInput> {
  const claims = input.subjectToken.claims as Record<string, CelInput>;

  return {
    claims,
    request: {
      permissions: input.tokenRequest.permissions,
      resource: input.tokenRequest.resource.href,
      scope: input.tokenRequest.scope,
    },
    subject: {
      claims,
      issuer: input.subjectToken.issuer,
      resolvedKeyId: input.subjectToken.resolvedKeyId,
      subjectTokenType: input.subjectToken.subjectTokenType,
    },
  };
}
