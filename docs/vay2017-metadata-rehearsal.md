# VAY-2017 metadata rehearsal

This is an isolated, read-only inventory of the restored VAY-2017 rehearsal database. It is not a production migration or cutover.

## Before each inventory

1. Confirm the isolated infrastructure root in `infra/vay2017-metadata-runner` is applied from an independently reviewed saved plan as described in `docs/vay2017-metadata-infrastructure-lane.md`. Also confirm the dedicated `vay2017-metadata-preflight` GitHub environment is restricted to `main`, requires the designated owner approval, and has administrator bypass disabled. Per the owner's decision, the designated owner may approve runs they initiated. The current shared `next` environment has no protection rules and must not be used for this workflow. Do not broaden the generic platform-deploy role to make apply pass.
2. From this repository, with an authorized, read-only operator AWS identity in the reviewed account, run:

   ```bash
   bash scripts/check-vay2017-rehearsal-isolation.sh
   ```

   This verifies the exact source snapshot and isolated restored instance, encryption/privacy, pinned image, dedicated VPC, no-internet/no-peering routes, endpoints, and security groups. It reads AWS metadata only; it does not connect to the database or inspect its contents. Do not dispatch the inventory if any check fails.
3. The new restored database is created with its dedicated PostgreSQL-only security group in the same approved infrastructure plan. The older restore in the shared default VPC is not used or modified. If the new restore does not have exactly the expected security group, stop and get a new plan/review; do not repair its access rules manually.
4. Immediately after a successful check, dispatch **VAY-2017 Metadata Inventory** from the protected `main` branch in GitHub Actions. The workflow has no caller-supplied command, database, or resource inputs. It starts the fixed Step Functions inventory and uploads only the sanitized metadata artifact.

The GitHub workflow role deliberately has no broad EC2, RDS, or ECR describe permissions. The dedicated environment approval is the enforceable gate for the separate operator check; the approver must confirm the successful check immediately before approving each run. Repeat it immediately before every dispatch to minimize configuration drift. Do not run the workflow until that environment's reviewer/bypass settings have been verified.

Never restore another database, read or export row contents, use a production credential, run a migration, change owner access, write to providers, cut over, or shut down the legacy system as part of this rehearsal. If the exact resource identity or isolation boundary differs from the checked-in attestation, stop and get the evidence and code reviewed again.
