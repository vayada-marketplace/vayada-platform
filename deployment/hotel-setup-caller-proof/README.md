# Public setup caller image proof

Source: `174e070290a7ab28379eb02bae52af35f6160537`.
Image: `sha256:d17d2c617940b40954bbb79735272b8b7818d42e555151feef7a25978a403baa`.
Source CI: https://github.com/vayada-marketplace/vayada/actions/runs/37078780531
Normal publication CI: https://github.com/vayada-marketplace/vayada/actions/runs/37082080058
Deployment dispatch was skipped. OCI revision was inspected and matches the source.

Actual compiled public creation and launch route admission was exercised with a synthetic authenticated Owner fixture and throwing ordinary-writer/transport spies: both retained-pair blocked requests returned 503 without writer or transport calls; launch response was uncached. Source validation passed 162 tests across the three affected test files and API type checking.

On 2026-10-03, `compat.mjs` passed inside this immutable image with network disabled. It imports the shipped compiled configuration and verifies ongoing Finance export cutoff, verify-full TLS, rejection without a CA, and the shipped launcher clearing the migration owner URL before executing the API. All credentials and key identifiers are synthetic. This source descends from the serving `74396f7e0618b4e4d248abe03852ea05b2eef9bc`; launcher and Finance worker implementation are unchanged.

This attestation covers public caller admission and existing runtime compatibility. It does not approve native property credentials, private property-service images, deployment, or recovery of either live Owner account.

## Atomic first Save successor — VAY-965

Primary source `6f903db20554e38b522c848667875744fc673ed3`, image `sha256:c2fbba1a4d3f8f7bc4c46d0816f125d3598cd1c1a4880dd3b103feb0d3aa67d2`, [publication](https://github.com/vayada-marketplace/vayada/actions/runs/37151539705). Rollback source `e966028dfdaec63ff40dd75d043b800295071668`, image `sha256:ac29c768aca69f1f0710e4278340f06031fc7f619b6c67d0cbc221b539ac2bac`, [publication](https://github.com/vayada-marketplace/vayada/actions/runs/37150950869). Both publication workflows skipped public deployment.

[The bounded dual receipt](../hotel-setup-atomic-image-receipt.json) binds both OCI revisions and successful actual compiled native creation/bootstrap proof on PG16/17. Each image's actual shell launcher was executed with synthetic npm/node spies in owner-present and owner-unset modes; migration/runtime URLs remain separated and the owner URL is removed before API execution. Actual compiled ongoing export configuration preserves the fixed cutoff, verified TLS and CA requirement. The launcher and Finance worker implementation are unchanged from the previously serving source. This is not a live server/worker execution or live vault publication proof.

The composed source adds normalized create-only initial launch settings, four new-property INSERT columns and wizard first-Save/reload retry handling. Existing public admission and private forwarding remain fail-closed. Source admission/parser tests and [full composed CI](https://github.com/vayada-marketplace/vayada/actions/runs/37151541087) must pass before protected activation. The existing d17 caller stays approved for the current blocked serving task; the old private creation images are replaced because their exact grant inventory lacks the four INSERT columns.

This staging change leaves both admissions blocked and both private services at zero. Existing property-purpose images and Finance settings are preserved. Final actual Owner Save/reload and later native PMS-purpose provisioning are separate acceptance steps.
