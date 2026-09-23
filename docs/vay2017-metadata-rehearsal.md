# VAY-2017 metadata rehearsal

This is an isolated, read-only inventory of the restored VAY-2017 rehearsal database. It is not a production migration or cutover.

## Before each inventory

1. Confirm the required infrastructure PR is merged and applied, and that the dedicated `vay2017-metadata-preflight` GitHub environment has a required independent reviewer and administrator bypass disabled. The current shared `next` environment has no protection rules and must not be used for this workflow. The VAY-2043 runner IAM roles currently need a separately reviewed provisioning path; do not broaden the generic platform-deploy role to make apply pass.
2. From this repository, with an authorized, read-only operator AWS identity in the reviewed account, run:

   ```bash
   bash scripts/check-vay2017-rehearsal-isolation.sh
   ```

   This verifies the exact source snapshot and restored instance, encryption/privacy, pinned image, private subnet/routes/endpoints, and dedicated security groups. It reads AWS metadata only; it does not connect to the database or inspect its contents. Do not dispatch the inventory if any check fails.
3. If the check says the restored instance still has its original shared security group, stop. Changing it is a separate AWS mutation and needs explicit approval. Only after approval, run `bash scripts/attach-vay2017-rehearsal-security-group.sh --apply`, then rerun the read-only isolation check and require it to pass.
4. Immediately after a successful check, dispatch **VAY-2017 Metadata Inventory** from the protected `main` branch in GitHub Actions. The workflow has no caller-supplied command, database, or resource inputs. It starts the fixed Step Functions inventory and uploads only the sanitized metadata artifact.

The GitHub workflow role deliberately has no broad EC2, RDS, or ECR describe permissions. The dedicated environment approval is the enforceable gate for the separate operator check; the reviewer must confirm the successful check immediately before approving each run. Repeat it immediately before every dispatch to minimize configuration drift. Do not run the workflow until that environment's reviewer/bypass settings have been verified.

Never restore another database, read or export row contents, use a production credential, run a migration, change owner access, write to providers, cut over, or shut down the legacy system as part of this rehearsal. If the exact resource identity or isolation boundary differs from the checked-in attestation, stop and get the evidence and code reviewed again.
