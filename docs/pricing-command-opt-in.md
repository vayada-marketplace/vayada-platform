# Pricing prerequisite staging

Ordinary platform changes leave
`enable_pricing_command_credential_infrastructure=false`. With no installed
pricing resources this proposes none of the seven pricing additions. This
changes source staging only; it grants no permissions or installation authority.

The separately approved pricing installation phase must explicitly set and
persist `enable_pricing_command_credential_infrastructure=true`. It creates the
same five empty secret containers, execution role and inline secret-read policy
in the existing normal root and state. Secret map keys remain unchanged.

The execution role and inline policy move to indexed addresses through explicit
`moved` blocks. A legacy installed state with the option enabled must show only
address moves, without replacement. All seven resources have `prevent_destroy`;
turning the option off after full or partial installation must fail. Partial
installation requires a separately reviewed recovery plan, not reuse of a fresh
seven-create approval.

Metadata refresh additionally requires the resources option. Its indexed role
reference rejects metadata-on/resources-off. No metadata permissions are
installed by this change.

The pricing owner must update the separate seven-create, two-update and final
no-op guards for the explicit option, indexed IAM/configuration references and
new reviewed source hash. Older saved-plan approvals or receipts are not valid
for this source. Do not merge the temporary identity preparation merely to
unblock unrelated plans, or use another root, targeted apply or imports.

Native offline fixtures prove default and explicit off, exact seven creates,
legacy address migration and refusal to disable full or partial installed
state. They use synthetic local state, fake provider credentials and disabled
AWS refresh. They do not prove live state or execute a production plan.
