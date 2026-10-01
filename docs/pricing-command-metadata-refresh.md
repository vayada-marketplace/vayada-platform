# VAY-1543 staged pricing metadata refresh

`enable_pricing_command_metadata_refresh` defaults to false. This preparatory
change therefore adds no permissions to either platform role. It supplies the
second operator phase described in [platform contract PR #251](https://github.com/vayada-marketplace/vayada-platform/pull/251).

After the seven empty pricing resources have been created through their
reviewed saved operator plan, keep competing platform writers paused. A separate
reviewed activation must set `enable_pricing_command_metadata_refresh=true` in
a checked-in `infra/*.auto.tfvars.json` file so later CI retains that state.
Review a fresh full saved operator plan: it must update only
`aws_iam_role_policy.platform_plan[0]` and
`aws_iam_policy.platform_writer_boundary[0]`, with the five known final secret
ARNs and the existing pricing execution-role ARN. Stop on any creation,
replacement, deletion, unrelated update, unknown ARN, or changed writer trust
or session-revocation cutoff. Apply only that reviewed saved plan, then require
the ordinary hosted plan to refresh to no-op before resuming writers.

Both policies gain `secretsmanager:DescribeSecret` and
`secretsmanager:GetResourcePolicy` on exactly the five pricing secrets. The
pinned AWS provider 5.100.0 reads both secret details and resource policy when
refreshing an `aws_secretsmanager_secret`. They also gain the four role/policy
read actions used by that provider on the exact pricing execution role. These
statements grant no secret values, KMS decrypt, resource writes, role passing,
or role assumption. Verify positive metadata access and negative value/write/
PassRole access against both actual platform roles before admitting traffic.

The preparation does not supply credentials, database grants, task definitions,
service routing, or deployment. Those remain later reviewed slices of
[VAY-1543](https://linear.app/vayadacom/issue/VAY-1543/use-unified-pricing-across-direct-offers-and-checkout).
