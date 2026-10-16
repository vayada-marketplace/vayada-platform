# CI image mirror

CI test jobs in `vayada` and `vayada-platform` start PostgreSQL and Node containers. Anonymous pulls
from ECR Public and Docker Hub kept failing with `toomanyrequests: Data limit exceeded`. GitHub's
runners share IP addresses, so other users often use up the anonymous limit first (VAY-2237). Those
jobs now pull public copies from the organization's GitHub registry (GHCR):

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

## How the mirror runs

`.github/workflows/mirror-ci-images.yml` runs `scripts/mirror-ci-image.sh` once per image. It runs
every Monday at 04:23 UTC and whenever someone starts it by hand. For each image it:

- reads the upstream digest, from ECR Public first and Docker Hub second;
- skips the image if the mirror already has that digest;
- otherwise copies it by digest with `skopeo copy --all --preserve-digests` and checks the mirror's
  digest afterwards.

Each attempt that fails is retried after 30, 60, 120, 240 and 480 seconds. Only runs on `main`
publish. A pull request that changes the workflow or script gets a dry run, which reads the digests
and reports what it would copy.

If a run fails, the mirror keeps the previous copy and CI is unaffected. Re-run the failed job: a new
runner usually has a different IP address.

Mirrored tags follow upstream with a delay of up to a week. To pick up a new upstream release sooner,
refresh by hand.

## Refresh now

Actions → **Mirror CI images** → **Run workflow** on `main`. Each job's summary shows the source,
the digest, and whether the image was copied or unchanged.

## Add an image

1. Add a row to the workflow's matrix: `image` and `tag` are the official Docker image and tag, and
   `package` is the GHCR package name (`ci-<image>`).
2. Merge, then run the workflow on `main`.
3. If the run created a new package, make sure it is public: open
   https://github.com/orgs/vayada-marketplace/packages, then the package, then **Package settings**.
   Under **Danger Zone**, choose **Change visibility** → **Public**.
4. Point the CI job at `ghcr.io/vayada-marketplace/<package>:<tag>`.

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

- `vayada`: `.github/workflows/pr-checks.yml`;
- `vayada-platform`: `.github/workflows/tf-validate.yml`, `.github/workflows/vay2042-*-test.yml` and
  `scripts/test-*.sh`.
