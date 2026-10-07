import pg from 'pg';

let client;
try {
  const mode = process.env.HOTEL_SETUP_COMMAND_MODE;
  const role = mode === 'property_creation' ? 'vayada_next_hotel_setup_creation_reader' :
    mode === 'property_commands' ? 'vayada_next_hotel_setup_reader' : undefined;
  const url = new URL(process.env.HOTEL_SETUP_COMMAND_READER_DATABASE_URL ?? '');
  if (!role || url.protocol !== 'postgresql:' ||
    url.hostname !== 'vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com' ||
    url.port !== '5432' || url.username !== role || url.pathname !== '/vayada_target_prod' ||
    !url.password || url.hash || url.search !== '?sslmode=verify-full' || !process.env.VAYADA_DB_RDS_CA_BUNDLE)
    throw new Error();
  client = new pg.Client({ host: url.hostname, port: 5432, database: 'vayada_target_prod',
    user: role, password: decodeURIComponent(url.password), connectionTimeoutMillis: 10000,
    query_timeout: 15000, statement_timeout: 15000,
    ssl: { ca: process.env.VAYADA_DB_RDS_CA_BUNDLE, rejectUnauthorized: true, servername: url.hostname },
    options: '-c default_transaction_read_only=on -c search_path=pg_catalog' });
  client.on('error', () => { process.exitCode = 1; });
  await client.connect();
  const { checkHotelSetupReader } = await import('/app/apps/api/dist/cli/hotelSetupReaderPreflight.js');
  await checkHotelSetupReader(client, mode);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const login = (await client.query('SELECT current_user,session_user')).rows[0];
  if (login?.current_user !== role || login?.session_user !== role) throw new Error();
  const result = (await client.query(`SELECT bool_and(NOT p.prosecdef AND
    has_function_privilege(current_user,p.oid,'EXECUTE') AND
    NOT has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION')) AS allowed,
    count(*)::int AS count FROM pg_proc p WHERE p.oid=ANY(ARRAY[
      to_regprocedure('platform.channex_management_worker_scope(text,text,uuid)'),
      to_regprocedure('platform.channex_management_worker_source(text,text,uuid)')])`)).rows[0];
  if (result?.allowed !== true || result.count !== 2) throw new Error();
  // Exercise the actual PUBLIC source-helper policy under the literal reader login.
  if ((await client.query('SELECT id FROM identity.organizations LIMIT 1')).rowCount !== 1) throw new Error();
  await client.query('ROLLBACK');
  if (process.exitCode) throw new Error();
  console.log(JSON.stringify({ status: 'PASS', scope: 'hotel_setup_reader_rls_native', role }));
} catch {
  console.error(JSON.stringify({ status: 'FAIL', code: 'hotel_setup_reader_rls_native_unavailable' }));
  process.exitCode = 1;
} finally { await client?.end().catch(() => {}); }
