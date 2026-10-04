// Run only the immutable bundle's read-only inspection; never print errors or data.
import { createRequire } from 'node:module';
const pg = createRequire('/app/apps/api/dist/cli/hotelSetupApprovedReadinessBackfill.js')('pg');
import { inspectApprovedReadiness, parseApprovedReadinessConfiguration } from '/app/apps/api/dist/cli/hotelSetupApprovedReadinessBackfill.js';
let phase = 'configuration';
let query = 0;
let rowCount = null;
let sqlState = null;
const original = pg.Client.prototype.query;
pg.Client.prototype.query = async function (...args) {
  // ROLLBACK cleanup must not replace the check that failed.
  if (args[0] === 'ROLLBACK') return original.apply(this, args);
  phase = `query_${String(++query).padStart(2, '0')}`;
  rowCount = null;
  try {
    const result = await original.apply(this, args);
    rowCount = Number.isInteger(result.rowCount) && result.rowCount >= 0 ? result.rowCount : null;
    return result;
  } catch (error) {
    sqlState = typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
    throw error;
  }
};
let inspectionStatus = 'FAIL';
try {
  const config = parseApprovedReadinessConfiguration(process.env);
  if (config.mode !== 'inspect') throw new Error();
  phase = 'connection';
  await inspectApprovedReadiness(config);
  inspectionStatus = 'PASS';
  phase = 'complete';
} catch {
  // SQLSTATE and an ordinal identify a check without exposing its values.
}
console.log(JSON.stringify({ status: 'PASS', mode: 'diagnose', inspectionStatus, phase, rowCount, sqlState }));
