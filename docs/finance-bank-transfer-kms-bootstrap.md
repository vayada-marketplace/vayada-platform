# Bank-transfer KMS bootstrap (VAY-1041)

The approved bootstrap created the symmetric key
`735fc88a-7043-47ba-96d2-4cc6fdfaa06d` in account `269416271598`, region
`eu-west-1`, with the Terraform key policy, six ownership tags and annual
rotation. The current alias is `alias/vayada/prod/finance-bank-transfer-current`.
Declarative imports in `infra/finance_bank_transfer_kms.tf` bring both resources
under the normal reviewed Terraform plan/apply workflow.

The CI role reached its aggregate inline-policy size limit. Its equivalent
scoped management policy is attached as the customer-managed policy
`vayada-platform-finance-bank-transfer-kms-v1`, following the existing Finance
steady-state policy template. It permits management of this exact key and alias,
plus alias discovery. It grants no key creation or cryptographic use and denies
key disablement, rotation disablement and scheduled deletion. No broad bootstrap
policy was installed.

The API receives the current ARN and allowlist through Terraform environment
entries. Its separate task-role policy permits encryption/decryption only for
the bank-transfer purpose, property, destination and revision context. No bank
credentials belong in Terraform, runtime environment settings or this document.
