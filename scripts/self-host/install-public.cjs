const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
function buildSql({transactional=true}={}) {
 const sql=fs.readFileSync(path.join(__dirname,'public-profiles.sql'),'utf8');
 const checksum=createHash('sha256').update(sql).digest('hex');
 const literal=x=>"'"+x.replaceAll("'","''")+"'";
 const body=`DO $install$ DECLARE existing text; BEGIN
 IF to_regclass('public.tokentracker_self_host_installations') IS NULL OR
  NOT EXISTS(SELECT 1 FROM public.tokentracker_cloud_policy WHERE hosting_mode='self_hosted') THEN
  RAISE EXCEPTION 'Install the registered private self-host baseline first'; END IF;
 SELECT checksum INTO existing FROM public.tokentracker_self_host_installations WHERE step='public-profiles-v1';
 IF FOUND THEN
  IF existing<>${literal(checksum)} THEN RAISE EXCEPTION 'Installed public addon changed'; END IF;
 ELSE
  IF to_regclass('public.tokentracker_user_settings') IS NOT NULL OR to_regclass('public.tokentracker_leaderboard_snapshots') IS NOT NULL THEN
   RAISE EXCEPTION 'Refusing unregistered public tables'; END IF;
  EXECUTE ${literal(sql)};
  INSERT INTO public.tokentracker_self_host_installations(step,checksum) VALUES('public-profiles-v1',${literal(checksum)});
 END IF;
 END $install$;
 NOTIFY pgrst,'reload schema';`;
 return (transactional?"BEGIN;\nSELECT pg_advisory_xact_lock(hashtextextended('tokentracker:self-host-install',0));\n":"")+body+(transactional?'\nCOMMIT;':'');
}
async function install(db){return db.transaction(async tx=>{await tx.exec("SELECT pg_advisory_xact_lock(hashtextextended('tokentracker:self-host-install',0))");await tx.exec(buildSql({transactional:false}));});}
if(require.main===module){const file=process.argv[2];if(!file)throw Error('Provide the output SQL path');fs.writeFileSync(path.resolve(file),buildSql()+'\n',{mode:0o600});}
module.exports={buildSql,install};
