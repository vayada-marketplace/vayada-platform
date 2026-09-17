# Coordinated next releases

Status: receiver and control-state support; automatic ownership remains disabled
until VAY-2029 completes integrated verification and activation.

`Deploy coordinated next release` consumes the versioned contract mirrored in
`deployment/contract`. It reconciles the API and five active next frontends as
one release while retaining the shared `production-ecs-mutations` lock for the
whole workflow run. Terraform, legacy deployment jobs, manual operations, and
rollback therefore cannot mutate production ECS concurrently with any API or
frontend release job.

## Fixed trust boundary

`deployment/coordinated-release-v1.json` is the only service-to-infrastructure
map. The receiver does not accept account, region, cluster, ECS service, task
family, container, or ECR repository from an event or environment label. It
accepts only:

- repository `vayada-marketplace/vayada`, branch `main`;
- the allowlisted build and publisher workflow paths;
- a successfully completed exact build run and attempt;
- a non-expired 90-day published artifact whose GitHub metadata names the
  exact trusted publisher run; that run may still be active on first dispatch
  or may have failed only after durable upload for a later redispatch;
- byte-exact manifest and published-record SHA-256 values;
- the exact six service keys, approved repositories, and immutable digests in
  the v1 manifest, plus an ECR `next-<imageSourceSha>` tag on each digest.

The `next` environment must provide `COORDINATED_RELEASE_READ_TOKEN` with
read-only Actions access to `vayada-marketplace/vayada`. The deployment jobs use
`vayada-github-actions-coordinated-deploy`, whose AWS policy is limited to the
six physical ECS services, six ECR repositories, existing task roles, and the
control-state prefix.

## Runtime state

Small JSON records live under
`/vayada/prod/coordinated-deployments/v1` in SSM Parameter Store:

| Record                             | Purpose                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| `ownership-mode`                   | `legacy` (also the missing-record default) or `batch`              |
| `desired-release`                  | newest accepted ordinary manifest and immutable artifact identity  |
| `services/<key>/provenance`        | last manifest proven against live ECS and smoke checks             |
| `services/<key>/hold`              | active/cleared durable manual or rollback hold                     |
| `checkpoints/<barrier>`            | evidence-bound checkpoint acknowledgment                           |
| `checkpoint-obligations`           | unresolved barriers retained even when successors omit them        |
| `checkpoint-completions/<barrier>` | proof that all six checkpoint services completed and were verified |
| `operations/<run>/<key>`           | prepared target, captured rollback target, and result              |

Terraform does not own these values. It owns only the role and policy that can
access the prefix, so an apply cannot replace runtime holds or provenance with
defaults. The deployment role has no `DeleteParameter` permission; resume
transitions a hold to `cleared` and retains its history.

## Release behavior

The prepare job validates the publication, verifies source ancestry, checks
barriers and holds, confirms every digest in ECR, and compares every desired
digest to live ECS. It writes `desired-release` before any ECS mutation. A
delayed older or divergent ordinary release cannot replace it. Duplicate runs
remain useful: they observe all six live services and repair an earlier partial
failure, including a carried-forward image. A newer manifest must name the
retained desired manifest and source as its immediate predecessor, so a lost or
delayed intermediate release cannot silently skip its checkpoint obligations.
Self-checkpoint barriers are persisted before desired state advances; successors
require both all-service checkpoint completion and the evidence acknowledgment.

The API job runs first. It captures the live task definition before mutation,
waits for ECS stability, checks public API health, and writes provenance only
after observing the desired digest. API failure prevents frontend jobs. The
five frontend jobs then run as a fail-fast-disabled matrix, retaining auth
gateway and public Booking smoke checks. One frontend failure does not roll
back a healthy API or cancel unrelated frontend jobs.

No-op services still run smoke and refresh manifest-bound provenance. If a
runner stops after ECS mutation but before state write, rerunning the same
artifact observes the live digest, reruns smoke, and records success; it never
assumes success from stale control state. State-write failure fails the run.

Before a supported automatic rollback, the operation writes an active service
hold containing the fixed physical identity and captured rollback task/image.
If that write fails, the rollback is not attempted. Ordinary releases report
held services and do not clear them. Every active API hold blocks dependent
frontend rollout unless the hold explicitly proves compatible; the supplied
controls deliberately default to incompatible/unknown.

## Explicit controls

`Manage coordinated release controls` shares the production mutation lock and
supports:

- `hold`: capture a physical service and reason before a manual operation;
- `acknowledge`: bind barrier ID/kind/introduction SHA, exact evidence
  requirement, optional required checkpoint manifest, and concrete evidence;
- `set-legacy-mode`: rollback of automatic ownership, not deletion of state.

Use `Deploy coordinated next release` with operation `resume` to resume one
held physical service. Supply the exact non-expired published artifact ID and
both content hashes. Resume validates that exact manifest under the same lock,
reconciles only the selected service, and clears the hold only after live-state
verification and smoke success. A failed resume leaves the hold active. An
explicit resume may select an older still-eligible manifest without changing
the ordinary `desired-release`; queued ordinary runs cannot substitute another
target inside that operation.

A barrier with `requiredCheckpointManifestId` may deploy that exact checkpoint
manifest before acknowledgment. Later releases remain blocked until an
evidence-bound acknowledgment exists. A barrier without a checkpoint blocks
until acknowledged. Unknown barrier kinds or corrupt/mismatched acknowledgment
records fail closed. This system does not run backfills automatically.

## Legacy, Terraform, and activation

Before activation, missing/`legacy` ownership keeps current
`app-image-published` events working. Manual use of `deploy.yml` for a managed
next service writes a durable hold before mutation. Its supported automatic
rollback also writes a hold first. The isolated maps canary continues using its
separate physical services and lock.

After the locked `activate` operation switches batch mode, queued or delayed automatic per-image events for the six
managed services fail before ECS mutation. Named manual recovery remains
available and held. Terraform Apply retains `production-ecs-mutations`; its
task-definition roll-forward preserves the current image and never clears
coordinated runtime state. A failed auth-gateway roll-forward writes a durable
hold before restoring its captured task definition. Legacy and landing services
remain outside batch ownership.

VAY-2029 owns the production sequence: apply the receiver IAM, configure and
test cross-repository artifact access, seed live provenance/holds, verify
barriers and duplicate/old-event behavior, drain old events, enable the
producer, then run `Deploy coordinated next release` with operation `activate`
and the exact latest artifact. That locked operation writes the desired release
before switching mode to `batch`, so any already-queued legacy events fail
before mutation. It then reconciles the bootstrap release and collects real
deployed evidence. This PR
does not set repository variables, apply Terraform, switch ownership, or claim
that mocked tests are deployed proof.

## Recovery

- Lost dispatch: redispatch the same published artifact; do not rebuild it.
- Partial frontend failure: rerun the same artifact or a newer complete
  descendant. Full-manifest comparison selects the still-drifted service.
- Crash after ECS update: rerun the exact artifact; observed live state and
  smoke recover provenance.
- Failed automatic rollback or manual intervention: preserve the hold, repair
  the service, then use explicit resume with a selected eligible manifest.
- Expired/missing/tampered artifact or divergent history: fail closed and
  publish a new complete release; never reconstruct desired state from tags or
  timestamps.
