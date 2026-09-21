# Deployment lock rehearsal

This manual, main-only workflow performs no AWS or deployment operations. It
holds the same workflow-level `production-ecs-mutations` concurrency group as
Terraform Apply, the coordinated receiver and the isolated recovery rehearsal.
It can delay those workflows while it runs; schedule it during the reviewed
deployment pause. Do not cancel unrelated queued runs to make room.

After exact merge/run approval, dispatch `rehearse-deployment-lock.yml` twice
from the same reviewed main commit. Record both run IDs. Capture the second
run's queued/pending status while the first run is executing its workers; if
the runs do not contend, the experiment is inconclusive and must not be
reported as a lock pass. Do not automatically retry it.

Use GitHub's run and attempt-specific jobs APIs as the evidence source:

```
gh api repos/vayada-marketplace/vayada-platform/actions/runs/RUN_ID
gh api repos/vayada-marketplace/vayada-platform/actions/runs/RUN_ID/attempts/1/jobs
```

Retain sanitized JSON with each run's ID, attempt, workflow path, event, head
branch/SHA, status/conclusion, and each job's name, status/conclusion,
started_at/completed_at, including worker sleep step timestamps. Require two
distinct runs, both attempt 1, both
successful manual runs at the reviewed main SHA. Each must contain successful
`begin`, `workers (one)`, `workers (two)` and `end` jobs. Compare job timestamps:

- Each worker starts after its run's begin completes.
- The worker sleep steps overlap (use their API step timestamps).
- End starts after both workers complete.
- The later run's begin starts after the earlier run's end completes, with no
  jobs from the two runs overlapping. Determine order from timestamps; GitHub
  does not promise dispatch order.

Also verify the concurrency group and workflow scope in the reviewed versions
of `tf-apply.yml`, `deploy-coordinated-release.yml` and this workflow. This
combines a hosted lock contention check across parallel child jobs with a
configuration check that Terraform uses that same lock. It does not exercise
Terraform apply, ECS mutations, legacy queued workflow revisions, migration
attestations or application smoke tests. A failed, cancelled, skipped or
noncontending run is not a successful lock rehearsal.
