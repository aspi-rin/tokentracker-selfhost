-- Optional, consent-based public projection. Private usage/RPC grants stay unchanged.
CREATE TABLE public.tokentracker_user_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  leaderboard_public boolean NOT NULL DEFAULT false,
  leaderboard_anonymous boolean NOT NULL DEFAULT false,
  display_name text CHECK (length(display_name)<=50),
  github_url text,
  show_github_url boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.tokentracker_leaderboard_snapshots (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period text NOT NULL CHECK (period IN ('week','month','total')),
  from_day date NOT NULL,to_day date NOT NULL,
  rank integer NOT NULL CHECK(rank>0),
  gpt_tokens bigint NOT NULL DEFAULT 0,claude_tokens bigint NOT NULL DEFAULT 0,
  gemini_tokens bigint NOT NULL DEFAULT 0,cursor_tokens bigint NOT NULL DEFAULT 0,
  opencode_tokens bigint NOT NULL DEFAULT 0,openclaw_tokens bigint NOT NULL DEFAULT 0,
  hermes_tokens bigint NOT NULL DEFAULT 0,kiro_tokens bigint NOT NULL DEFAULT 0,
  copilot_tokens bigint NOT NULL DEFAULT 0,kimi_tokens bigint NOT NULL DEFAULT 0,
  other_tokens bigint NOT NULL DEFAULT 0,
  total_tokens bigint NOT NULL CHECK(total_tokens>=0),
  estimated_cost_usd numeric NOT NULL DEFAULT 0 CHECK(estimated_cost_usd>=0),
  display_name text,avatar_url text,github_url text,
  is_public boolean NOT NULL DEFAULT false,
  generated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,period,from_day,to_day)
);
CREATE INDEX self_host_public_rank ON public.tokentracker_leaderboard_snapshots(period,from_day,to_day,rank);
ALTER TABLE public.tokentracker_user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_leaderboard_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_user_settings,public.tokentracker_leaderboard_snapshots FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.tokentracker_user_settings,public.tokentracker_leaderboard_snapshots TO project_admin;
-- Explicit profile names only. Never derive a public identity from an email address.
CREATE VIEW public.tokentracker_user_profiles AS
 SELECT user_id,coalesce(display_name,'Anonymous') AS display_name,NULL::text AS avatar_url
 FROM public.tokentracker_user_settings;
-- Readers check current consent even if an old snapshot survives or a writer is delayed.
CREATE VIEW public.tokentracker_public_leaderboard AS
 SELECT s.user_id,s.period,s.from_day,s.to_day,s.rank,s.gpt_tokens,s.claude_tokens,s.gemini_tokens,
 s.cursor_tokens,s.opencode_tokens,s.openclaw_tokens,s.hermes_tokens,s.kiro_tokens,s.copilot_tokens,
 s.kimi_tokens,s.other_tokens,s.total_tokens,s.estimated_cost_usd,
 CASE WHEN u.leaderboard_anonymous THEN 'Anonymous' ELSE coalesce(u.display_name,'Anonymous') END AS display_name,
 NULL::text AS avatar_url,
 CASE WHEN u.leaderboard_anonymous OR NOT u.show_github_url THEN NULL ELSE u.github_url END AS github_url,
 true AS is_public,s.generated_at
 FROM public.tokentracker_leaderboard_snapshots s
 JOIN public.tokentracker_user_settings u USING(user_id)
 WHERE u.leaderboard_public AND s.is_public;
REVOKE ALL ON public.tokentracker_user_profiles,public.tokentracker_public_leaderboard FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.tokentracker_user_profiles,public.tokentracker_public_leaderboard TO project_admin;

CREATE FUNCTION public.self_host_set_public_profile(p_user_id uuid,p_patch jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
DECLARE s public.tokentracker_user_settings;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('tokentracker:public-publication',0));
 INSERT INTO tokentracker_user_settings(user_id) VALUES(p_user_id) ON CONFLICT DO NOTHING;
 UPDATE tokentracker_user_settings SET
 leaderboard_public=CASE WHEN p_patch?'enabled' THEN (p_patch->>'enabled')::boolean ELSE leaderboard_public END,
 leaderboard_anonymous=CASE WHEN p_patch?'anonymous' THEN (p_patch->>'anonymous')::boolean ELSE leaderboard_anonymous END,
 display_name=CASE WHEN p_patch?'display_name' THEN p_patch->>'display_name' ELSE display_name END,
 github_url=CASE WHEN p_patch?'github_url' THEN p_patch->>'github_url' ELSE github_url END,
 show_github_url=CASE WHEN p_patch?'show_github_url' THEN (p_patch->>'show_github_url')::boolean ELSE show_github_url END,
 updated_at=clock_timestamp() WHERE user_id=p_user_id RETURNING * INTO s;
 IF NOT s.leaderboard_public THEN DELETE FROM tokentracker_leaderboard_snapshots WHERE user_id=p_user_id; END IF;
 RETURN jsonb_build_object('enabled',s.leaderboard_public,'anonymous',s.leaderboard_anonymous,
  'display_name',s.display_name,'github_url',s.github_url,'show_github_url',s.show_github_url,'updated_at',s.updated_at);
END $fn$;
CREATE FUNCTION public.self_host_publish_snapshots(p_period text,p_from date,p_to date,p_rows jsonb,p_generated_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
DECLARE n integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('tokentracker:public-publication',0));
 IF p_period NOT IN ('week','month','total') OR p_from>p_to OR jsonb_typeof(p_rows)<>'array' THEN RAISE EXCEPTION 'Invalid publication'; END IF;
 IF p_generated_at < (SELECT max(generated_at) FROM tokentracker_leaderboard_snapshots WHERE period=p_period) THEN
  RETURN jsonb_build_object('published',0,'stale',true);
 END IF;
 DELETE FROM tokentracker_leaderboard_snapshots WHERE period=p_period;
 INSERT INTO tokentracker_leaderboard_snapshots(user_id,period,from_day,to_day,rank,
 gpt_tokens,claude_tokens,gemini_tokens,cursor_tokens,opencode_tokens,openclaw_tokens,hermes_tokens,kiro_tokens,
 copilot_tokens,kimi_tokens,other_tokens,total_tokens,estimated_cost_usd,is_public,generated_at)
 SELECT r.user_id,p_period,p_from,p_to,row_number() OVER(ORDER BY r.total_tokens DESC,r.user_id)::integer,
 coalesce(r.gpt_tokens,0),coalesce(r.claude_tokens,0),coalesce(r.gemini_tokens,0),coalesce(r.cursor_tokens,0),
 coalesce(r.opencode_tokens,0),coalesce(r.openclaw_tokens,0),coalesce(r.hermes_tokens,0),coalesce(r.kiro_tokens,0),
 coalesce(r.copilot_tokens,0),coalesce(r.kimi_tokens,0),coalesce(r.other_tokens,0),r.total_tokens,
 coalesce(r.estimated_cost_usd,0),true,p_generated_at
 FROM jsonb_to_recordset(p_rows) AS r(user_id uuid,gpt_tokens bigint,claude_tokens bigint,gemini_tokens bigint,
 cursor_tokens bigint,opencode_tokens bigint,openclaw_tokens bigint,hermes_tokens bigint,kiro_tokens bigint,
 copilot_tokens bigint,kimi_tokens bigint,other_tokens bigint,total_tokens bigint,estimated_cost_usd numeric)
 JOIN tokentracker_user_settings u ON u.user_id=r.user_id
 WHERE u.leaderboard_public AND r.total_tokens>0;
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN jsonb_build_object('published',n);
END $fn$;
REVOKE ALL ON FUNCTION public.self_host_set_public_profile(uuid,jsonb),
 public.self_host_publish_snapshots(text,date,date,jsonb,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.self_host_set_public_profile(uuid,jsonb),
 public.self_host_publish_snapshots(text,date,date,jsonb,timestamptz) TO project_admin;
