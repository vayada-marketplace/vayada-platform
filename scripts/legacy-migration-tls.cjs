'use strict';
// VAY-1362: loaded with `node --require` before a backend-migration CLI in the go-day one-off task.
// Every pg Client and Pool the CLI creates gets an explicit TLS object: the pinned RDS CA, certificate
// and hostname verification. Hosts that are not pinned are refused. The URL's own SSL parameters are
// removed, so pg's URL parser cannot override the object. Same shape as the app's historical-binding
// preflight: { ca, rejectUnauthorized: true, servername }.
const { readFileSync } = require('node:fs');

const settings = JSON.parse(process.env.LEGACY_MIGRATION_TLS || 'null');
if (!settings || typeof settings.ca !== 'string' || typeof settings.cliDir !== 'string' ||
    !Array.isArray(settings.hosts) || settings.hosts.length === 0)
  throw new Error('legacy_migration_tls_invalid');
const ca = readFileSync(settings.ca, 'utf8');
// The same pg module the CLI resolves, patched before any ESM import snapshots its exports.
const pg = require(require.resolve('pg', { paths: [settings.cliDir] }));
const SSL_PARAMETERS = new Set(['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'sslpassword', 'uselibpqcompat']);

function pinned(config) {
  const options = typeof config === 'string' ? { connectionString: config } : { ...config };
  let url;
  try {
    url = new URL(options.connectionString);
  } catch {
    throw new Error('database_url_not_pinned');
  }
  if (!settings.hosts.includes(url.hostname) || (url.port || '5432') !== '5432') throw new Error('database_host_not_pinned');
  for (const key of [...url.searchParams.keys()]) if (SSL_PARAMETERS.has(key.toLowerCase())) url.searchParams.delete(key);
  // pg lets query parameters such as host, port, user or dbname override the URL, so only a label may remain.
  if ([...url.searchParams.keys()].some((key) => key !== 'application_name')) throw new Error('database_url_not_pinned');
  return { ...options, connectionString: url.toString(), ssl: { ca, rejectUnauthorized: true, servername: url.hostname } };
}

const { Client, Pool } = pg;
pg.Client = class PinnedClient extends Client {
  constructor(config) {
    super(pinned(config));
  }
};
pg.Pool = class PinnedPool extends Pool {
  constructor(config) {
    super(pinned(config));
  }
};
