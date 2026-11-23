# Google Maps key editor (VAY-2589)

The booking page's map uses one browser Maps key (`GOOGLE_MAPS_BROWSER_API_KEY` in GitHub). Google
refuses it on any website missing from the key's website list, and the room map then shows "The map
couldn't load right now". next-api adds each hotel booking domain to that list itself, a minute after
it starts and then hourly, for every domain in `infra/booking_custom_domains.auto.tfvars.json`. A
domain is routed (and so listed) before its hotel can verify it in Booking Admin.

It only adds `https://<domain>/*`. It never removes an entry or changes the key's other settings, and
it leaves a key without a website list alone.

## One-time Google setup

Google can't limit a service account to a single API key. The role below works on every API key in
the Maps key's project, so check the count in step 1.

1. Open https://console.cloud.google.com/apis/credentials signed in with the Google account that owns
   the Maps key, and pick its project at the top. Click the key whose "Show key" value ends in the
   same characters as the live key. Note:
   - the key ID: the part of the address after `/key/`;
   - the project number: https://console.cloud.google.com/home/dashboard, card "Project info";
   - how many API keys the Credentials page lists. If there are others, stop and decide first: the
     service account could change them too. The clean way out is a new browser key in a project of
     its own (then `GOOGLE_MAPS_BROWSER_API_KEY` in GitHub changes and the web apps are rebuilt).
2. https://console.cloud.google.com/apis/library/apikeys.googleapis.com → **Enable**.
3. https://console.cloud.google.com/iam-admin/roles → **Create role**: title `Vayada Maps key editor`,
   ID `vayadaMapsKeyEditor`, stage General Availability. **Add permissions**: tick
   `apikeys.keys.get` and `apikeys.keys.update` only → **Add** → **Create**.
4. https://console.cloud.google.com/iam-admin/serviceaccounts → **Create service account**: name
   `vayada-maps-key-editor` → **Create and continue** → role: Custom → `Vayada Maps key editor` →
   **Continue** → **Done**.
5. Open the new service account → **Keys** → **Add key** → **Create new key** → JSON → **Create**. A
   `.json` file lands in Downloads. Don't open it or send it anywhere. If Google says key creation is
   disabled by an organization policy, stop here.

## Into SSM

The key file goes straight from Downloads into SSM and is then deleted; it is never pasted or shown.
Fill in the three values from above:

```bash
KEY_FILE="$HOME/Downloads/<file name>.json"
KEY_NAME="projects/<project number>/locations/global/keys/<key ID>"
aws ssm put-parameter --profile vayada --region eu-west-1 \
  --name /vayada/prod/next-api-google-maps-key-editor --type SecureString \
  --value "file://$KEY_FILE" --query Version --output text \
&& aws ssm put-parameter --profile vayada --region eu-west-1 \
  --name /vayada/prod/next-api-google-maps-key-name --type String \
  --value "$KEY_NAME" --query Version --output text \
&& rm "$KEY_FILE"
```

Both must exist before this repo's change applies (tf-apply checks), or the new next-api task can't
start. So this repo's change merges only after the check below says `RESULT: ready`.

## Check (read-only)

```bash
node scripts/check-google-maps-key-editor.mjs
```

It reads the key and prints its website list and which routed hotel domains are on it. It also checks
that the service account is refused listing the project's keys and reading a key string. `RESULT:
ready` means next-api can do its part.

## Replacing the service account key

1. Create a new JSON key (step 5).
2. Store it over the old one:

   ```bash
   KEY_FILE="$HOME/Downloads/<file name>.json"
   aws ssm put-parameter --profile vayada --region eu-west-1 \
     --name /vayada/prod/next-api-google-maps-key-editor --type SecureString --overwrite \
     --value "file://$KEY_FILE" --query Version --output text \
   && rm "$KEY_FILE"
   ```

3. Start new next-api tasks, which read it at start, and wait until the deployment is COMPLETED:

   ```bash
   aws ecs update-service --profile vayada --region eu-west-1 --cluster vayada-backend-cluster \
     --service vayada-next-api-service --force-new-deployment --query service.deployments[0].id
   ```

4. Run the check, then delete the old key under the service account's **Keys**.
