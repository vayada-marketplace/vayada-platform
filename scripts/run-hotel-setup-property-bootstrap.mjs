import { writeFileSync } from 'node:fs';
const host = 'vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com';
// The wrapper provides only the pinned public RDS root, never native credentials.
const ca = process.env.VAYADA_DB_RDS_CA_BUNDLE;
if (!ca) throw new Error('Pinned CA required');
writeFileSync('/tmp/hotel-setup-rds.pem', ca, { mode: 0o600 });
process.env.NODE_EXTRA_CA_CERTS = '/tmp/hotel-setup-rds.pem';
const admin = new URL(process.env.HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL);
if (admin.protocol !== 'postgresql:' || admin.hostname !== host || admin.port !== '5432' ||
    admin.username !== 'vayada_admin' || admin.pathname !== '/postgres' || admin.hash ||
    admin.search !== '?sslmode=require' || !admin.password) {
  throw new Error('Unexpected production owner URL shape');
}
admin.pathname = '/vayada_target_prod';
admin.search = '?sslmode=verify-full';
process.env.HOTEL_SETUP_PROPERTY_ADMIN_DATABASE_URL = admin.toString();
process.env.HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT = `postgresql://${admin.host}${admin.pathname}`;
// A fresh child reads NODE_EXTRA_CA_CERTS at startup. Both proof roots are fixed in the image.
const { spawnSync } = await import('node:child_process');
const result = spawnSync(process.execPath, ['/app/apps/api/dist/cli/hotelSetupPropertyBootstrap.js'], {
  env: process.env, stdio: 'inherit',
});
process.exit(result.status ?? 1);
