# VAY-2339: move vayada-database off the default group and off its public address

`vayada-database` (RDS PostgreSQL, eu-west-1) is not in Terraform. It sits in the
default VPC security group `sg-0089fc5e42fa33566`, which also opens port 8000 to
`0.0.0.0/0` for the dead legacy service `vayada-backend-service`, and it has
`PubliclyAccessible = true`. This runbook moves it to `vayada-database-sg`
(Terraform, platform #640) and turns the public address off.

Every client is an ECS task in `vayada-ecs-tasks-sg` and reaches the database
inside the VPC, where its DNS name already resolves to the private address. AWS:
both changes happen without downtime ("Downtime doesn't occur during this
change"). AWS calls the public-access change immediate, but on 2026-10-25 RDS
showed it about 2 minutes after the call. It never appears in
`PendingModifiedValues`, so `wait_db` waits for the target state and the DNS
answer, not just "available". The only public-path user was
`scripts/run_migration.sh` (app #3729 retires it).

The coordinator runs each step from a laptop and checks it before the next one.
Order: P1 applied, R0, R1, R2, R3, R4, P2 applied, R5, final check.

## Setup (bash, from a vayada-platform checkout on main)

```bash
for v in $(env | grep '^AWS_' | cut -d= -f1); do unset "$v"; done
aws_() { aws --profile vayada --region eu-west-1 "$@"; }
[ "$(aws_ sts get-caller-identity --query Account --output text)" = 269416271598 ] || echo "STOP: wrong account"
PLATFORM="$PWD"
DB=vayada-database
HOST=vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com
OLD_SG=sg-0089fc5e42fa33566
NEW_SG=$(aws_ ec2 describe-security-groups \
  --filters Name=vpc-id,Values=vpc-055e8074dc3b2422a Name=group-name,Values=vayada-database-sg \
  --query 'SecurityGroups[0].GroupId' --output text)
[ "$NEW_SG" = sg-06f9484b713fb0145 ] || echo "STOP: unexpected NEW_SG=$NEW_SG"   # created by #640 on 2026-10-24
SERVICES="vayada-booking-admin-service vayada-booking-backend-service vayada-booking-frontend-service
  vayada-next-api-service vayada-next-booking-admin-service vayada-next-booking-frontend-service
  vayada-next-marketplace-admin-service vayada-next-pms-frontend-service vayada-pms-backend-service
  vayada-pms-frontend-service"
EVIDENCE_DIR=~/.local/share/vayada-testing/evidence/VAY-2339-2026-10-25
mkdir -p "$EVIDENCE_DIR" && chmod 700 "$EVIDENCE_DIR"
```

### Checks (define once, run after every step)

```bash
db_state() {
  aws_ rds describe-db-instances --db-instance-identifier "$DB" --output json --query \
    'DBInstances[0].{status:DBInstanceStatus,public:PubliclyAccessible,groups:VpcSecurityGroups,pending:PendingModifiedValues}'
}
dns_ok() {  # $1 = expected public flag; from outside the VPC a private instance resolves to 172.31.x
  ip=$(dig +short "$HOST" | tail -1)
  case "$1:$ip" in
    false:172.31.*) return 0 ;;
    true:172.31.* | true:) return 1 ;;
    true:*) return 0 ;;
    *) return 1 ;;
  esac
}
wait_db() {  # $1 = expected groups (space-separated), $2 = expected public flag (true|false)
  want=$(printf '%s\n' $1 | sort | jq -R . | jq -sc .)
  for _ in $(seq 1 60); do
    s=$(db_state)
    if jq -e --argjson g "$want" --argjson p "$2" '.status=="available" and .pending=={} and .public==$p and
        all(.groups[]; .Status=="active") and ([.groups[].VpcSecurityGroupId] | sort)==$g' <<<"$s" >/dev/null &&
       dns_ok "$2"; then
      echo "$s"; echo "dig: $ip"; return 0
    fi
    sleep 10
  done
  echo "STOP: instance not in the expected state after 10 minutes"; echo "$s"; echo "dig: $ip"; return 1
}
checks() {
  echo "== instance"; db_state
  echo "== target health (expect only 'healthy')"
  for tg in $(aws_ ecs describe-services --cluster vayada-backend-cluster --services $SERVICES \
      --query 'services[].loadBalancers[].targetGroupArn' --output text); do
    echo "$(aws_ elbv2 describe-target-health --target-group-arn "$tg" \
      --query 'TargetHealthDescriptions[].TargetHealth.State' --output text) ${tg#*targetgroup/}"
  done
  echo "== HTTP (expect 200; booking /health/db must say connected)"
  for u in https://next-api.vayada.com/health https://pms-api.vayada.com/health https://booking-api.vayada.com/health/db; do
    echo "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$u") $u"
  done
  curl -s --max-time 10 https://booking-api.vayada.com/health/db; echo
  echo "== database errors in service logs, last 10 minutes (expect []; compare with the R0 baseline)"
  now=$(date +%s)
  qid=$(aws_ logs start-query --start-time $((now - 600)) --end-time "$now" --query queryId --output text \
    --log-group-names /ecs/vayada-next-api /ecs/vayada-pms-backend /ecs/vayada-booking-backend \
    --query-string 'filter @message like /ECONNREFUSED|ETIMEDOUT|Connection terminated|timeout exceeded when trying to connect|could not connect|connection was closed/ | stats count(*) as errors by @log')
  for _ in $(seq 1 30); do
    r=$(aws_ logs get-query-results --query-id "$qid" --output json)
    [ "$(jq -r .status <<<"$r")" = Complete ] && break; sleep 2
  done
  jq -c '{status, results, scanned: .statistics.recordsScanned}' <<<"$r"
  echo "== DatabaseConnections per minute, last 10 minutes (no drop to ~0)"
  aws_ cloudwatch get-metric-statistics --namespace AWS/RDS --metric-name DatabaseConnections \
    --dimensions Name=DBInstanceIdentifier,Value="$DB" --period 60 --statistics Average \
    --start-time "$(date -u -v-10M +%Y-%m-%dT%H:%M:%SZ)" --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --query 'sort_by(Datapoints,&Timestamp)[].Average' --output text
}
# Fresh connections: new one-off tasks in vayada-ecs-tasks-sg (the group every client uses).
# Both are read-only; each prints a PASS line and exits 0 (up to 5 minutes each).
fresh() {
  (cd "$PLATFORM" && AWS_PROFILE=vayada bash scripts/run-target-database-runtime-preflight.sh) &&
  (cd "$PLATFORM" && AWS_PROFILE=vayada bash scripts/run-target-database-runtime-preflight.sh --check-rds-admin-login)
}
```

## R0: baseline and preconditions (read-only)

```bash
gh run list --repo vayada-marketplace/vayada-platform --status in_progress --json workflowName,databaseId
gh run list --repo vayada-marketplace/vayada --status in_progress --json workflowName,databaseId
# Expect: no release train, deploy or tf-apply running. Hold merges until R5 is done.
db_state | tee "$EVIDENCE_DIR/r0-instance.json"
# Expect: available, public true, groups [sg-0089fc5e42fa33566 active], pending {} (else STOP:
# --apply-immediately below would also apply whatever is pending).
aws_ ec2 describe-security-group-rules --filters Name=group-id,Values="$NEW_SG" --output json \
  --query 'SecurityGroupRules[].{egress:IsEgress,proto:IpProtocol,from:FromPort,to:ToPort,cidr:CidrIpv4,group:ReferencedGroupInfo.GroupId}' \
  | tee "$EVIDENCE_DIR/r0-new-sg-rules.json"
# Expect exactly: 3 ingress tcp 5432 from sg-0d34c8671b6d5480e, sg-00b784ffd9629271d, sg-0ca103b6c27a86ba1;
# 1 egress -1 0.0.0.0/0.
aws_ ec2 describe-security-group-rules --filters Name=group-id,Values="$OLD_SG" --output json > "$EVIDENCE_DIR/r0-old-sg-rules.json"
aws_ ec2 describe-network-interfaces --filters Name=group-id,Values="$OLD_SG" \
  --query 'NetworkInterfaces[].[NetworkInterfaceId,RequesterId,Description]' --output text
# Expect: the RDS interface only (a vayada-backend-service attempt may show briefly).
aws_ ecs describe-services --cluster vayada-backend-cluster --services vayada-backend-service --output json > "$EVIDENCE_DIR/r0-vayada-backend-service.json"
aws_ iam get-role-policy --role-name vayada-github-actions-deploy --policy-name migrate-auth-db-runtime \
  --query PolicyDocument --output json > "$EVIDENCE_DIR/r0-migrate-auth-db-runtime.policy.json"
dig +short "$HOST" | tail -1   # before R5: the public 54.195.242.82
checks | tee "$EVIDENCE_DIR/r0-checks.txt"
fresh | tee "$EVIDENCE_DIR/r0-fresh.txt"
```

## R1: attach both groups (no access change: the union of both)

```bash
aws_ rds modify-db-instance --db-instance-identifier "$DB" \
  --vpc-security-group-ids "$NEW_SG" "$OLD_SG" --apply-immediately \
  --query 'DBInstance.VpcSecurityGroups' --output json
wait_db "$NEW_SG $OLD_SG" true | tee "$EVIDENCE_DIR/r1-instance.json"
checks | tee "$EVIDENCE_DIR/r1-checks.txt"
```

Rollback: `aws_ rds modify-db-instance --db-instance-identifier "$DB" --vpc-security-group-ids "$OLD_SG" --apply-immediately`, then `wait_db "$OLD_SG" true`.

## R2: the new group only

```bash
aws_ rds modify-db-instance --db-instance-identifier "$DB" \
  --vpc-security-group-ids "$NEW_SG" --apply-immediately \
  --query 'DBInstance.VpcSecurityGroups' --output json
wait_db "$NEW_SG" true | tee "$EVIDENCE_DIR/r2-instance.json"
checks | tee "$EVIDENCE_DIR/r2-checks.txt"
fresh | tee "$EVIDENCE_DIR/r2-fresh.txt"          # proves NEW connections from vayada-ecs-tasks-sg
```

Existing connections are tracked and stay open; `fresh` is the real test.
Rollback: `aws_ rds modify-db-instance --db-instance-identifier "$DB" --vpc-security-group-ids "$NEW_SG" "$OLD_SG" --apply-immediately`
(or `"$OLD_SG"` alone), then `wait_db "$NEW_SG $OLD_SG" true` (or `wait_db "$OLD_SG" true`) and `checks`.

## R3: delete vayada-backend-service (port 8000 user; dead since 2026-04)

Its image repository was deleted on 2026-10-19 (VAY-2259, platform #586), so it
cannot start; it retries every ~13 minutes. It is not in Terraform.

```bash
aws_ ecs update-service --cluster vayada-backend-cluster --service vayada-backend-service \
  --desired-count 0 --query 'service.desiredCount'
aws_ ecs wait services-stable --cluster vayada-backend-cluster --services vayada-backend-service
aws_ ecs delete-service --cluster vayada-backend-cluster --service vayada-backend-service --query 'service.status'
aws_ ec2 describe-network-interfaces --filters Name=group-id,Values="$OLD_SG" --query 'length(NetworkInterfaces)'
# Expect 0: nothing is left in the default group.
checks | tee "$EVIDENCE_DIR/r3-checks.txt"
```

The HTTPS listener's default action still forwards to the now-empty
`vayada-backend-tg` (unknown hosts get a 503, as today); a VAY-2259 follow-up
ticket handles it. Rollback: none needed, as the service could not run. Its
definition is saved in `r0-vayada-backend-service.json`.

## R4: delete the inline policy that could open the database group

`migrate-auth-db-runtime` on `vayada-github-actions-deploy` (hand-made, not in
Terraform) allowed `ec2:AuthorizeSecurityGroupIngress` on the default group with
no condition. Run after app #3729 is merged.

```bash
aws_ iam delete-role-policy --role-name vayada-github-actions-deploy --policy-name migrate-auth-db-runtime
aws_ iam list-role-policies --role-name vayada-github-actions-deploy --query PolicyNames
```

Rollback: `aws_ iam put-role-policy --role-name vayada-github-actions-deploy --policy-name migrate-auth-db-runtime --policy-document "$(cat "$EVIDENCE_DIR/r0-migrate-auth-db-runtime.policy.json")"`.

## P2: merge and apply (Terraform)

P2 removes the old 5432 rules from the default group, drops `var.rds_sg_id` and
adopts `aws_default_security_group` with no rules (this deletes both 8000 rules
and the self rules). Apply only after R2 and R3 passed. Then:

```bash
aws_ ec2 describe-security-group-rules --filters Name=group-id,Values="$OLD_SG" --query 'length(SecurityGroupRules)'   # 0
checks | tee "$EVIDENCE_DIR/p2-checks.txt"
```

Rollback: revert P2 and apply; the database no longer depends on the default group.

## R5: turn the public address off

```bash
aws_ rds modify-db-instance --db-instance-identifier "$DB" --no-publicly-accessible --apply-immediately \
  --query 'DBInstance.PendingModifiedValues'
wait_db "$NEW_SG" false | tee "$EVIDENCE_DIR/r5-instance.json"   # public false, dig 172.31.16.221
checks | tee "$EVIDENCE_DIR/r5-checks.txt"
fresh | tee "$EVIDENCE_DIR/r5-fresh.txt"
```

Rollback: `aws_ rds modify-db-instance --db-instance-identifier "$DB" --publicly-accessible --apply-immediately`, then `wait_db "$NEW_SG" true`
(AWS may assign a new public IP; `dns_ok` only requires a non-private answer).

## Final state

- `vayada-database`: `PubliclyAccessible = false`, groups `[vayada-database-sg]`.
- `vayada-database-sg`: 5432 from the three ECS task groups, egress all.
- Default VPC group: no rules, no members.
- Database access from outside the VPC is impossible. Production database work
  runs as reviewed one-off ECS tasks (`scripts/legacy-migration-oneoff.sh`,
  `scripts/run-target-database-runtime-preflight.sh`).

## Done 2026-10-25

The coordinator ran every step from platform 04e46feec (evidence in
`~/.local/share/vayada-testing/evidence/VAY-2339-2026-10-25/`; times UTC):

| Step | Time | Result |
|---|---|---|
| P1 #640 | 22:35 | tf-apply: 6 added; `vayada-database-sg` = `sg-06f9484b713fb0145`, exactly the 4 rules |
| R0 | 22:40 | public true, `[sg-0089…]`, pending `{}`; only the RDS interface in the default group; checks green; fresh PASS ×2 |
| R1 | 22:43 | both groups active; checks green |
| R2 | 22:44 | `[sg-06f9484b713fb0145]` only; 10/10 targets healthy, 0 errors, 16–20 connections; fresh PASS ×2 |
| R3 | 22:47 | `vayada-backend-service` desired 0, deleted; 0 interfaces left in the default group |
| R4 | 23:04 | `migrate-auth-db-runtime` deleted (after app #3729, 482f27f8e) |
| P2 #642 | 23:09 | tf-apply: 1 added (default group adopted), 4 destroyed; default group 0 rules, 0 interfaces |
| R5 | 23:10 | call sent; the old `wait_db` returned on the old state; public false about 2 minutes later |
| R5 verify | 23:13 | dig 172.31.16.221; 10/10 healthy; 0 errors; 16–29 connections; fresh PASS ×2 |
