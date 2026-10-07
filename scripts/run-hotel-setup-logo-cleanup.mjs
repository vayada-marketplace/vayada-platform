import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const ca = process.env.VAYADA_DB_RDS_CA_BUNDLE;
if (!ca) throw new Error('Pinned CA required');
writeFileSync('/tmp/hotel-setup-rds.pem', ca, { mode: 0o600 });
process.env.NODE_EXTRA_CA_CERTS = '/tmp/hotel-setup-rds.pem';
process.env.HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT = 'postgresql://vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/vayada_target_prod';
const result = spawnSync(process.execPath, ['/app/apps/api/dist/cli/hotelSetupLogoCleanup.js'], {
  env: process.env, stdio: 'inherit',
});
process.exit(result.status ?? 1);
