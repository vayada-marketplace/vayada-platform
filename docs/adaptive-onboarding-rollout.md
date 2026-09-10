# Next Marketplace adaptive onboarding

The app handoff shipped in vayada#1805 (VAY-1051). The owner authorized next
activation on September 10, 2026. Legacy form retirement remains separate.

Use the **Deploy App** workflow (`deploy.yml`) with service
`next-marketplace-frontend`, environment `next`, and `adaptive_onboarding=enabled`.
Use the currently running Marketplace image tag and digest so activation does not
also change application code. Verify its source includes app commit
`af3c26de7382edb00c75e19555109c4a14cb0dc9` first.

The workflow changes only `HOTEL_SETUP_ADAPTIVE_SHELL_ENABLED` on the rendered
next Marketplace deployment task. Automated image deployments default to
`preserve` and inherit the running flag. Terraform is not applied by this action;
a future Terraform task-definition rollout must deliberately preserve this flag.
The rollback task retains the pre-deployment environment and current image.

After ECS stabilizes, verify the running task flag and image, then visit ordinary
`/setup` using the reusable hotel owner. Check existing hotel selection, saved
progress, additional hotel prerequisites, and product return navigation. Validate
new-hotel creation with bounded synthetic data after coordinating shared fixtures.
Do not use `_adaptive` or calendar recovery parameters to prove general activation.

To revert the flag, run the same workflow on the current image with
`adaptive_onboarding=disabled`. ECS deployment or existing smoke failure triggers
automatic rollback; a hotel onboarding UI failure requires this explicit revert.
Do not remove old forms until the replacement passes its acceptance checks.
