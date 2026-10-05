import assert from 'node:assert/strict';
import pg from 'pg';
import {repairTenantHelpers} from './hotel-setup-tenant-helper-repair.mjs';
// Run only against an owned disposable local clone matching the production DB name.
const url=new URL(process.env.TEST_DATABASE_URL??'');
assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/vayada_target_prod');assert.equal(url.search,'?sslmode=verify-full');
const principal=decodeURIComponent(new URL(process.env.TEST_DATABASE_URL).username);
const c=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});await c.connect();
try{
 const functions='platform.tenant_scope_key(text,uuid,uuid),platform.valid_tenant_scope(text,uuid,uuid)';
 await c.query(`REVOKE EXECUTE ON FUNCTION ${functions} FROM PUBLIC,vayada_next_hotel_setup_scope,vayada_next_hotel_setup_property_scope`);
 for(const fn of functions.split(/,(?=platform\.)/)) await c.query(`ALTER FUNCTION ${fn} OWNER TO ${c.escapeIdentifier(principal)}`);
 const before=(await c.query('SELECT count(*)::text AS n FROM hotel_catalog.properties')).rows;
 let r=await repairTenantHelpers(c,'inspect',undefined,principal);assert.equal(r.status,'PASS');assert.equal(r.missingEdges,4);
 assert.equal((await repairTenantHelpers(c,'apply','0'.repeat(64),principal)).status,'FAIL');
 assert.deepEqual(await repairTenantHelpers(c,'inspect',undefined,principal),r);
 let applied=await repairTenantHelpers(c,'apply',r.fingerprint,principal);assert.equal(applied.status,'PASS');assert.equal(applied.addedEdges,4);
 r=await repairTenantHelpers(c,'inspect',undefined,principal);assert.equal(r.status,'PASS');assert.equal(r.missingEdges,0);
 assert.equal((await repairTenantHelpers(c,'apply',r.fingerprint,principal)).addedEdges,0);
 assert.deepEqual((await c.query('SELECT count(*)::text AS n FROM hotel_catalog.properties')).rows,before);
 await c.query('ALTER ROLE vayada_next_hotel_setup_scope CREATEROLE');
 try{assert.equal((await repairTenantHelpers(c,'inspect',undefined,principal)).status,'FAIL');}
 finally{await c.query('ALTER ROLE vayada_next_hotel_setup_scope NOCREATEROLE');}
 const query=c.query.bind(c);
 for(const fault of ['lostCommit','readback']){
  await query(`REVOKE EXECUTE ON FUNCTION ${functions} FROM vayada_next_hotel_setup_scope,vayada_next_hotel_setup_property_scope`);
  const inspection=await repairTenantHelpers(c,'inspect',undefined,principal);assert.equal(inspection.status,'PASS');
  let committed=false,failed=false;
  c.query=async(sql,...args)=>{
   if(fault==='readback'&&committed&&!failed&&sql==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'){failed=true;throw new Error('synthetic readback failure');}
   const result=await query(sql,...args);
   if(sql==='COMMIT'){committed=true;if(fault==='lostCommit'&&!failed){failed=true;throw new Error('synthetic lost acknowledgement');}}
   return result;
  };
  let outcome;
  try{outcome=await repairTenantHelpers(c,'apply',inspection.fingerprint,principal);}
  finally{c.query=query;}
  assert.equal(outcome.status,fault==='lostCommit'?'UNCERTAIN':'COMMITTED_UNVERIFIED');
  assert.equal((await repairTenantHelpers(c,'inspect',undefined,principal)).missingEdges,0);
 }
 console.log('exact edges, stale fingerprint, replay, unsafe parent, lost COMMIT, postcommit readback and no business writes PASS');
}finally{await c.end();}
