export const requiredPolicyConsumerRoles = [
  "vayada_next_api_runtime",
  "vayada_next_identity_runtime",
];
export const optionalPolicyConsumerRoles = ["vayada_next_finance_expense_worker"];
export const policyConsumerRoleCandidates = [
  ...requiredPolicyConsumerRoles,
  ...optionalPolicyConsumerRoles,
];

export function selectPolicyConsumerRoles(existingRoles) {
  const selected = policyConsumerRoleCandidates.filter(role => existingRoles.includes(role));
  if (requiredPolicyConsumerRoles.some(role => !selected.includes(role)))
    throw new Error("channex_worker_required_policy_consumer_missing");
  return selected;
}
