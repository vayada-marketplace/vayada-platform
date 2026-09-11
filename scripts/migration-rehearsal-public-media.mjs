// Retained data only: no publication, projection rebuild, identity grant or upload.
import { createHash as publicHash } from "node:crypto";
import { createRequire as publicRequire } from "node:module";
import { binding, requireTrue } from "./migration-rehearsal-reader-contract.mjs";
import { runReadOnlyApplication } from "./migration-rehearsal-app-readonly.mjs";
const publicBucket = "vayada-rehearsal-7200a43a-269416271598";
const publicCdn = "https://d30tn7en2eythj.cloudfront.net/";
const publicBaseline = "d5c52a18f986911c1c33656eaad48e2ed0e154448c5874664599f625395e357b";
const missingSlug = "vay1361-absent-public-profile-27ba9106a4be3e023992ca59";
export const profileSamplesSql = `WITH candidates AS (
  SELECT p.canonical_slug AS slug,
    COALESCE(NULLIF(BTRIM(p.public_identity->>'name'),''),p.public_id) AS name,
    COALESCE(NULLIF(BTRIM(p.public_identity->>'propertyId'),''),p.public_id) AS id,
    COALESCE(p.public_visibility='public_safe' AND p.profile_status='public'
      AND (p.expires_at IS NULL OR p.expires_at > now()+interval '5 minutes')
      AND (c.profile_status='complete' OR (c.profile_status='incomplete'
        AND cardinality(c.completeness_reasons)=1 AND 'description'=ANY(c.completeness_reasons)
        AND NULLIF(BTRIM(b.hero_subtext),'') IS NOT NULL)),false) AS eligible,
    count(*) OVER (PARTITION BY p.canonical_slug) AS matches
  FROM distribution.public_hotel_bookability_profiles p
  LEFT JOIN hotel_catalog.property_public_profile_read_model c ON c.property_id=p.property_id
  LEFT JOIN booking.booking_settings b ON b.property_id=p.property_id
  WHERE p.expires_at IS NULL OR p.expires_at<=now() OR p.expires_at>now()+interval '5 minutes'
), ranked AS (
  SELECT *, row_number() OVER (PARTITION BY eligible ORDER BY slug) AS rank
  FROM candidates WHERE matches=1 AND NOT EXISTS (
    SELECT 1 FROM hotel_catalog.property_slugs a WHERE a.slug=candidates.slug
      AND a.purpose='redirect' AND a.status='redirected')
) SELECT slug,name,id,eligible FROM ranked WHERE rank<=2 ORDER BY eligible,slug`;
export const mediaSamplesSql = `WITH candidates AS (
  SELECT m.id::text, m.bucket,m.visibility,m.public_approved AS approved,
    v.storage_key AS key,v.public_cdn_url AS url,v.content_type AS mime,
    v.size_bytes::int AS bytes,v.checksum_sha256 AS checksum,
    row_number() OVER (PARTITION BY m.visibility ORDER BY m.id) AS rank
  FROM platform.media_objects m JOIN platform.media_variants v ON v.media_object_id=m.id AND v.visibility=m.visibility
  JOIN platform.production_media_migration_items i ON i.media_object_id=m.id
    AND i.source_run_id=$1 AND i.item_status='completed' AND i.source_system=m.source_system
    AND i.source_table=m.source_table AND i.source_row_id=m.source_row_id AND i.purpose=m.purpose
    AND i.content_checksum_sha256=m.checksum_sha256 AND i.size_bytes=m.size_bytes
  JOIN platform.production_media_migration_runs r ON r.source_run_id=i.source_run_id AND r.status='completed'
  WHERE m.storage_kind='vayada_managed' AND m.lifecycle_status='active'
    AND m.purpose IN ('property.hero_image','property.gallery_image','property.logo','pms.room_type.media','booking.header_logo')
    AND v.variant_name=CASE WHEN m.visibility='public' THEN 'original_safe' ELSE 'provider_original' END
    AND v.size_bytes BETWEEN 1 AND 5242880
) SELECT id,bucket,visibility,approved,key,url,mime,bytes,checksum FROM candidates WHERE rank<=2 ORDER BY visibility,id`;

export function mediaReadTarget(row) {
  requireTrue(/^[0-9a-f-]{36}$/.test(row.id ?? "") && row.bucket===publicBucket
    && ['public','private'].includes(row.visibility) && Number.isSafeInteger(row.bytes) && row.bytes>0 && row.bytes<=5242880
    && /^image\/[a-z0-9.+-]+$/.test(row.mime ?? "") && /^[0-9a-f]{64}$/.test(row.checksum ?? ""), "MEDIA_SAMPLE_SCOPE");
  const variant = row.visibility==='public' ? 'original_safe' : 'provider_original';
  const prefix = `${row.visibility}/media/${row.id}/${variant}/sha256-${row.checksum}.`;
  requireTrue(typeof row.key==='string' && row.key.startsWith(prefix) && /^[a-z0-9]+$/.test(row.key.slice(prefix.length)), "MEDIA_KEY_SCOPE");
  if (row.visibility==='public') requireTrue(row.approved===true && row.url===publicCdn+row.key.slice(7), "MEDIA_PUBLIC_APPROVAL");
  else requireTrue(row.url===null && row.approved===false, "PRIVATE_MEDIA_PUBLIC_URL");
  return row.visibility==='public' ? row.url : publicCdn+row.key;
}

export async function checkMediaBytes(body, row) {
  const hash = publicHash('sha256');
  let size=0;
  for await (const chunk of body) { size+=chunk.length; requireTrue(size<=row.bytes, "MEDIA_SIZE_OVERFLOW"); hash.update(chunk); }
  requireTrue(size===row.bytes && hash.digest('hex')===row.checksum, "MEDIA_BYTES_MISMATCH");
}

export async function checkPublicProfiles(get, reader, assertPublicSafe) {
  const samples=(await reader.query(profileSamplesSql)).rows;
  const absent=(await reader.query(`SELECT EXISTS(SELECT 1 FROM distribution.public_hotel_bookability_profiles WHERE canonical_slug=$1)
    OR EXISTS(SELECT 1 FROM hotel_catalog.property_slugs WHERE slug=$1) AS found`,[missingSlug])).rows[0];
  requireTrue(absent?.found===false,"MISSING_SLUG_COLLISION");
  let allowed=0, denied=0;
  for (const sample of [...samples,{slug:missingSlug,eligible:false}]) {
    for (const prefix of ['/api/booking-web/hotels/','/api/ai/hotels/']) {
      const response=await get(prefix+encodeURIComponent(sample.slug));
      requireTrue(response.status===(sample.eligible?200:404),"PUBLIC_PROFILE_STATUS");
      const body=await response.json();
      if (!sample.eligible) {
        const message=prefix.startsWith('/api/booking-web/')?'Booking Web hotel profile not found.':'Public hotel profile not found.';
        requireTrue(Object.keys(body).sort().join(',')==='error,message,statusCode' && body.statusCode===404
          && body.error==='Not Found' && body.message===message,"UNPUBLISHED_PROFILE_DISCLOSURE");
        denied++; continue;
      }
      assertPublicSafe(body);
      requireTrue(body.contractVersion==='public-bookability.v1' && body.publicVisibility==='public_safe'
        && body.hotel?.name===sample.name && body.hotel?.propertyId===sample.id, "PUBLIC_PROFILE_CONTRACT");
      if (body.freshness?.status!=='fresh') requireTrue(body.hotel.trust?.bookabilityStatus!=='bookable',"STALE_PROFILE_BOOKABLE");
      const rateLimitPolicy=prefix.startsWith('/api/booking-web/')?'public-booking-web-profile-read':'public-ai-profile-read';
      requireTrue(response.headers.get('cache-control')==='no-store',"PUBLIC_PROFILE_CACHE");
      requireTrue(response.headers.get('x-vayada-ratelimit-policy')===rateLimitPolicy,"PUBLIC_PROFILE_RATE_LIMIT_POLICY");
      const urls=[...(body.hotel.images??[]).map(image=>image.url),body.hotel.branding?.logoUrl,body.hotel.branding?.heroImage].filter(Boolean);
      for (const url of urls) {
        requireTrue(typeof url==='string' && url.startsWith(publicCdn+'media/'),"PUBLIC_PROFILE_MEDIA_ORIGIN");
        const proof=(await reader.query(`SELECT EXISTS(SELECT 1 FROM platform.media_objects m JOIN platform.media_variants v ON v.media_object_id=m.id
          WHERE v.public_cdn_url=$1 AND m.bucket=$2 AND m.visibility='public' AND v.visibility='public'
          AND m.public_approved AND m.lifecycle_status='active') AS found`,[url,publicBucket])).rows[0];
        requireTrue(proof?.found===true,"PUBLIC_PROFILE_MEDIA_APPROVAL");
      }
      allowed++;
    }
  }
  return { allowedRequests:allowed,deniedRequests:denied,existingProfileSamples:samples.length,positivePublicProfileProven:allowed>0 };
}

export async function checkMigratedMedia(reader, getObject, http) {
  const samples=(await reader.query(mediaSamplesSql,[binding.sourceRun])).rows;
  const checked={privateObjects:0,publicObjects:0,publicCdnDeliveries:0,privateAnonymousDenials:0};
  for (const sample of samples) {
    const url=mediaReadTarget(sample);
    const object=await getObject(sample);
    requireTrue(object.ContentLength===sample.bytes && object.ContentType===sample.mime,"MEDIA_OBJECT_METADATA");
    await checkMediaBytes(object.Body,sample);
    if (sample.visibility==='public') {
      const response=await http(url,'GET');
      requireTrue(response.status===200 && response.headers.get('content-type')===sample.mime,"PUBLIC_CDN_DELIVERY");
      await checkMediaBytes(response.body,sample);
      checked.publicObjects++; checked.publicCdnDeliveries++;
    } else {
      for (const target of [url,`https://${publicBucket}.s3.eu-west-1.amazonaws.com/${sample.key}`]) {
        const response=await http(target,'GET');
        await response.body?.cancel?.();
        requireTrue(response.status===403,"PRIVATE_MEDIA_ANONYMOUS_ACCESS");
        checked.privateAnonymousDenials++;
      }
      checked.privateObjects++;
    }
  }
  return checked;
}

export async function runPublicMediaReads(Client,env) {
  const req=publicRequire(process.cwd()+'/package.json');
  const {S3Client,GetObjectCommand}=req('@aws-sdk/client-s3');
  const {assertPublicBookabilityPublicSafe}=req('@vayada/domain-distribution');
  const s3=new S3Client({region:'eu-west-1',endpoint:'https://s3.eu-west-1.amazonaws.com',maxAttempts:1});
  let profiles,media,inventory;
  try {
    const runtime=await runReadOnlyApplication(Client,env,async(get,reader,before)=>{
      requireTrue(before.sha256===publicBaseline,"MIGRATED_ROWS_CHANGED");
      inventory={profiles:(await reader.query(`SELECT profile_status,count(*)::int AS count FROM distribution.public_hotel_bookability_profiles GROUP BY profile_status ORDER BY profile_status`)).rows,
        catalog:(await reader.query(`SELECT profile_status,count(*)::int AS count FROM hotel_catalog.property_public_profile_read_model GROUP BY profile_status ORDER BY profile_status`)).rows,
        media:(await reader.query(`SELECT visibility,lifecycle_status,count(*)::int AS count FROM platform.media_objects GROUP BY visibility,lifecycle_status ORDER BY visibility,lifecycle_status`)).rows};
      profiles=await checkPublicProfiles(get,reader,assertPublicBookabilityPublicSafe);
      media=await checkMigratedMedia(reader,
        row=>s3.send(new GetObjectCommand({Bucket:publicBucket,Key:row.key}),{abortSignal:AbortSignal.timeout(15000)}),
        (url,method)=>fetch(url,{method,redirect:'error',signal:AbortSignal.timeout(15000)}));
    });
    return {status:'PASS',scope:'public-media-read-only-probes',runId:binding.runId,release:binding.release,
      inventory,profiles,media,dataSha256:runtime.dataSha256,applicationStopped:true,
      browserProven:false,authenticatedDomainReadsProven:false,fullSmokeAccepted:false};
  } finally {s3.destroy();}
}
