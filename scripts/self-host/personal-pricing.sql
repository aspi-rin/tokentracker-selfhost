CREATE TABLE public.tokentracker_pricing_catalog (
  id integer PRIMARY KEY CHECK (id=1),
  payload jsonb NOT NULL CHECK (payload->>'schemaVersion'='1' AND length(payload->>'version')=64)
);
REVOKE ALL ON public.tokentracker_pricing_catalog FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.tokentracker_pricing_catalog TO project_admin;
CREATE FUNCTION public.self_host_publish_pricing(p_previous_version text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v_previous text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('tokentracker:pricing-catalog',0));
  SELECT payload->>'version' INTO v_previous FROM tokentracker_pricing_catalog WHERE id=1;
  IF v_previous IS NOT NULL AND v_previous<>p_previous_version THEN RETURN jsonb_build_object('ok',false,'code','catalog_changed'); END IF;
  INSERT INTO tokentracker_pricing_catalog(id,payload) VALUES(1,p_payload)
    ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload;
  RETURN jsonb_build_object('ok',true);
END $$;
REVOKE ALL ON FUNCTION public.self_host_publish_pricing(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.self_host_publish_pricing(text,jsonb) TO project_admin;
