# CI image mirror

CI test jobs in `vayada` and `vayada-platform` start PostgreSQL and Node containers. Anonymous pulls
from ECR Public and Docker Hub kept failing with `toomanyrequests: Data limit exceeded`. GitHub's
runners share IP addresses, so other users often use up the anonymous limit first (VAY-2237). Those
jobs therefore pull public copies from the organization's GitHub registry (GHCR):

| Mirror | Copied from |
|---|---|
| `ghcr.io/vayada-marketplace/ci-postgres:15-alpine` | `postgres:15-alpine` |
| `ghcr.io/vayada-marketplace/ci-postgres:16-alpine` | `postgres:16-alpine` |
| `ghcr.io/vayada-marketplace/ci-postgres:17-alpine` | `postgres:17-alpine` |
| `ghcr.io/vayada-marketplace/ci-postgres:16` | `postgres:16` |
| `ghcr.io/vayada-marketplace/ci-postgres:17` | `postgres:17` |
| `ghcr.io/vayada-marketplace/ci-node:22-bookworm` | `node:22-bookworm` |

The copies come from the official Docker images and have the same digests, including every platform.
The packages are public, so any job, laptop or cloud worker can pull them without logging in.

Point a CI job at a mirror only after its first run (below) has made the package public.

## How the mirror runs

`.github/workflows/mirror-ci-images.yml` runs `scripts/mirror-ci-image.sh` once per image. It runs
every Monday at 04:23 UTC and whenever someone starts it by hand. For each image it:

- reads the upstream digest, from ECR Public first and Docker Hub second;
- skips the image if the mirror already has that digest;
- otherwise copies it by digest with `skopeo copy --all --preserve-digests` and checks the mirror's
  digest afterwards;
- checks that the mirror can be pulled without logging in.

A failed attempt is retried after 15, 45 and 120 seconds. Only runs on `main` publish. A pull request
that changes the workflow or script gets a dry run, which reads the digests and reports what it would
copy.

If a run fails, the mirror keeps the previous copy and CI is unaffected. Re-run the failed job. A
runner whose address has used up the anonymous limits stays blocked, and a new runner usually has a
different address. GitHub notifies only the person who last edited a scheduled workflow about its
failures, so look at the Actions tab now and then. GitHub also turns off scheduled workflows in a
public repository after 60 days without repository activity; turn it back on in the Actions tab.

Mirrored tags follow upstream with a delay of up to a week. To pick up a new upstream release sooner,
refresh by hand.

## First run

1. In the organization's Settings → Packages, "Package creation" must allow **Public**.
2. Run the workflow on `main`. The first run creates the `ci-postgres` and `ci-node` packages.
3. Open https://github.com/orgs/vayada-marketplace/packages. If a package is private, open its
   **Package settings** and under **Danger Zone** choose **Change visibility** → **Public**.
   The workflow fails with "not pullable without logging in" until the package is public.
4. Re-run any failed jobs. Each job should end with "copied" or "unchanged".

Only then point CI jobs at the mirror.

## Refresh now

Actions → **Mirror CI images** → **Run workflow** on `main`. Each job's summary shows the source,
the digest, and whether the image was copied or unchanged.

## Add an image

1. Add a row to the workflow's matrix: `image` and `tag` are the official Docker image and tag, and
   `package` is the GHCR package name (`ci-<image>`).
2. Merge, then run the workflow on `main`. For a new package, follow the first-run steps.
3. Point the CI job at `ghcr.io/vayada-marketplace/<package>:<tag>`.

## Keep in mind

- Do not delete "untagged" versions of these packages. Each tag is an index that points to one
  image per platform plus attestations, and those show up as untagged versions. Deleting them breaks
  every tag that points to them.
- Anyone who can push to `vayada-platform` can change this workflow and publish to these packages.
  PR checks in both repositories run whatever the packages contain. Review changes to the workflow
  and script as you would review CI.

## Check a mirror against upstream

```bash
skopeo inspect --raw docker://ghcr.io/vayada-marketplace/ci-postgres:16-alpine | sha256sum
skopeo inspect --raw docker://public.ecr.aws/docker/library/postgres:16-alpine | sha256sum
```

The two hashes are the same unless upstream has published a newer image since the last refresh.

## If GHCR is unavailable

There is no automatic fallback. Revert the VAY-2237 commits that switched CI to the mirror, or
replace the image names by hand:

- `ghcr.io/vayada-marketplace/ci-postgres:` becomes `public.ecr.aws/docker/library/postgres:`;
- `ghcr.io/vayada-marketplace/ci-node:` becomes `public.ecr.aws/docker/library/node:`.

The image names appear in:

- `vayada`: `.github/workflows/pr-checks.yml` and `scripts/test-identity-runtime-row-scope.sh`;
- `vayada-platform`: `.github/workflows/tf-validate.yml`, `.github/workflows/vay2042-*-test.yml` and
  `scripts/test-*.sh`.

`vay2042-source-reader-test.yml` used Docker Hub's `postgres:` before the switch. The ECR Public
name works the same.
