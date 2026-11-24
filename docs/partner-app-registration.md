# Partner app registration (VAY-2441)

A partner app (Creator Links first) is registered once per app, in the live database. Only ECS tasks
reach the database, so the registration runs as the one-off task
`vayada-next-api-partner-app-registration` (`infra/partner_app_registration.tf`). It writes the app's
client id and secret into a new Secrets Manager secret under `partner-apps/prod/`, never into output
or logs. It runs with next-api's task role, which may create such secrets but can't read, change or
delete any.

Registering writes to production: only with Flamur's go at that time.

## The webhook signing key

`/vayada/prod/partner-webhook-signing-key` must exist before this repo's change applies (tf-apply
checks it), or the new next-api task can't start. It's base64 of 32 random bytes, a SecureString,
never shown. Create it once, with the value passed through stdin, never as an argument:

```bash
openssl rand -base64 32 | tr -d '\n' | aws ssm put-parameter --profile vayada --region eu-west-1 \
  --name /vayada/prod/partner-webhook-signing-key --type SecureString --value file:///dev/stdin \
  --query Version --output text
```

Never change it: each partner app's webhook signing secret is derived from it, so a new key changes
them all and each partner would need a new handover.

## Before registering

- The `next-latest` image includes app PR VAY-2441 (`registerPartnerApp.js` with `--secret-name`)
  and is the build next-api runs: compare its digest
  (`aws ecr describe-images --repository-name vayada-next-api --image-ids imageTag=next-latest`)
  with the running next-api task's `containers[0].imageDigest` (`aws ecs describe-tasks`).
- Until VAY-2438 is live, register without `--webhook-url` (the command refuses it).

## Register

Run the task with next-api's network settings and a command override. Without `--apply` it only
prints what it would store. Return addresses must match exactly what the partner sends (https; plain
http only for `localhost`). Repeat `--redirect-uri` for each.

```bash
region=eu-west-1
network="$(aws ecs describe-services --cluster vayada-backend-cluster \
  --services vayada-next-api-service --region "$region" \
  --query 'services[0].networkConfiguration' --output json)"
overrides="$(jq -cn '{containerOverrides:[{name:"vayada-next-api-partner-app-registration",
  command:["node","apps/api/dist/cli/registerPartnerApp.js",
    "--name","Creator Links test",
    "--redirect-uri","http://localhost:3000/admin/connect/vayada",
    "--redirect-uri","http://localhost:3000/hotel/connect/vayada",
    "--secret-name","partner-apps/prod/creator-links-test",
    "--apply"]}]}')"
aws ecs run-task --cluster vayada-backend-cluster \
  --task-definition vayada-next-api-partner-app-registration --launch-type FARGATE \
  --network-configuration "$network" --overrides "$overrides" --region "$region" \
  --query 'tasks[0].taskArn' --output text
```

The task logs one line to `/ecs/vayada-next-api` (stream prefix `partner-app-registration`):
`{"registered":true,…,"clientId":"partner_…","secretName":"partner-apps/prod/…"}`. It never logs the
secret. If the secret name is taken, it refuses and registers nothing: use a new name. If it fails
after starting, it logs the secret name and the client id it tried, and that app wasn't saved (or,
with `"appSaved":"unknown"`, check `distribution.external_api_clients` for the client id). Delete
such a secret; never hand it over.

## Hand over

On the Mac that hands the credentials to the partner, with the Vayada AWS login (check the account
with `aws sts get-caller-identity --profile vayada` first), from a vayada app checkout with its
dependencies installed:

```bash
AWS_PROFILE=vayada AWS_REGION=eu-west-1 npm run partner:secret-to-keychain -w vayada-api -- \
  --secret-name partner-apps/prod/creator-links-test
```

It copies the credentials into the macOS Keychain (service `toolbox-env`, accounts
`VAYADA_CLIENT_ID`, `VAYADA_CLIENT_SECRET` and, for an app with a webhook address,
`VAYADA_WEBHOOK_SECRET`), checks them there, then deletes the Secrets Manager secret for good. Nothing
is printed but the client id and the setting names, including any it replaced or that an earlier app
left. The client id must be the one in the task's `"registered":true` line.

Creator Links reads these as environment variables. Load them only for Creator Links (for example
from its own folder's `.envrc` with `security find-generic-password -s toolbox-env -a NAME -w`),
not in `~/toolbox/secrets/load.zsh`, which would put the client secret in every terminal.
