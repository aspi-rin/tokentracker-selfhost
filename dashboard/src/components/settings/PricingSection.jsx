import React, { useEffect, useState } from "react";
import { getInsforgeAnonKey, getInsforgeRemoteUrl } from "../../lib/insforge-config";
import { functionUrlFor, fetchFunctionResponse } from "../../lib/function-url";
import { cloudBillingRequest } from "../../lib/cloud-billing";
import { getLocalApiAuthHeaders } from "../../lib/local-api-auth";
import { isLocalDashboardHost } from "../../lib/host-mode";
import { Button } from "../../ui/components/Button.jsx";
import { SectionCard } from "./Controls.jsx";
import { copy } from "../../lib/copy";
export function PricingSection({auth,signedIn}) {
  const [catalog,setCatalog]=useState(null),[local,setLocal]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(false);
  useEffect(()=>{const ctrl=new AbortController();
    (async()=>{try{
      const r=await fetchFunctionResponse(functionUrlFor(getInsforgeRemoteUrl(),"tokentracker-pricing"),{headers:{apikey:getInsforgeAnonKey()},signal:ctrl.signal});
      if(!r.ok)throw Error();const next=await r.json();if(!ctrl.signal.aborted)setCatalog(next);
      if(isLocalDashboardHost()){
        const r=await fetch('/functions/tokentracker-pricing-status',{headers:await getLocalApiAuthHeaders(),signal:ctrl.signal});
        const value=r.ok?await r.json():{version:null,stale:true};if(!ctrl.signal.aborted)setLocal(value);
      }
    }catch{if(!ctrl.signal.aborted)setError(true);}})();return()=>ctrl.abort();
  },[]);
  async function refresh(){if(busy)return;setBusy(true);setError(false);try{
    setCatalog(await cloudBillingRequest("refresh", {auth,body:{},functionName:"tokentracker-pricing"}));
  }catch{setError(true);}finally{setBusy(false);}}
  return <SectionCard title={copy("personal.pricing.title")}>
    <div className="space-y-2 text-sm text-oai-gray-500">
      <p>{copy("personal.pricing.description")}</p>
      {catalog?<><p className="break-all">{copy("personal.pricing.version",{version:catalog.version.slice(0,12)})}</p><p>{copy("personal.pricing.updated",{when:new Date(catalog.updatedAt).toLocaleString()})}</p><p className="break-all">{catalog.source === "bundled" ? copy("personal.pricing.bundled") : catalog.source}</p></>:null}
      {local && (local.stale || local.version!==catalog?.version)?<p role="status" className="text-amber-700 dark:text-amber-400">{copy("personal.pricing.local_stale")}</p>:null}
      {error?<p role="alert" className="text-red-600">{copy("personal.pricing.error")}</p>:null}
      <Button variant="secondary" disabled={busy || !signedIn} onClick={refresh}>{copy(busy?"shared.loading":"personal.pricing.refresh")}</Button>
    </div>
  </SectionCard>;
}
