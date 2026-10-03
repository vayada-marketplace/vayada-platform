# Public setup caller image proof

Source: `174e070290a7ab28379eb02bae52af35f6160537`.
Image: `sha256:d17d2c617940b40954bbb79735272b8b7818d42e555151feef7a25978a403baa`.
Source CI: https://github.com/vayada-marketplace/vayada/actions/runs/37078780531
Normal publication CI: https://github.com/vayada-marketplace/vayada/actions/runs/37082080058
Deployment dispatch was skipped. OCI revision was inspected and matches the source.

Actual compiled public creation and launch route admission was exercised with a synthetic authenticated Owner fixture and throwing ordinary-writer/transport spies: both retained-pair blocked requests returned 503 without writer or transport calls; launch response was uncached. Source validation passed 162 tests across the three affected test files and API type checking.

On 2026-10-03, `compat.mjs` passed inside this immutable image with network disabled. It imports the shipped compiled configuration and verifies ongoing Finance export cutoff, verify-full TLS, rejection without a CA, and the shipped launcher clearing the migration owner URL before executing the API. All credentials and key identifiers are synthetic. This source descends from the serving `74396f7e0618b4e4d248abe03852ea05b2eef9bc`; launcher and Finance worker implementation are unchanged.

This attestation covers public caller admission and existing runtime compatibility. It does not approve native property credentials, private property-service images, deployment, or recovery of either live Owner account.
