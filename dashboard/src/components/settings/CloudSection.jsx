import React from "react";
import { Button } from "../../ui/components/Button.jsx";
import { SectionCard, ToggleSwitch } from "./Controls.jsx";
import { SyncDevices } from "./SyncDevices.jsx";
import { CloudUsageExport } from "../cloud/CloudUsageExport.jsx";
import { PricingSection } from "./PricingSection.jsx";
import { useAccountProfileSettings } from "./useAccountProfileSettings.js";
import { getInsforgeRemoteUrl } from "../../lib/insforge-config";
import { copy } from "../../lib/copy";
export function CloudSection({ settings, active=true }={}) {
  return settings ? <PersonalSyncSettings settings={settings} active={active}/> : <StandaloneSyncSettings active={active}/>;
}
function StandaloneSyncSettings({active}) { const settings=useAccountProfileSettings(); return <PersonalSyncSettings settings={settings} active={active}/>; }
function PersonalSyncSettings({settings:current,active}) {
  if(!active)return null;
  return <div className="space-y-6">
    <SectionCard title={copy("personal.sync.title")}>
      <p className="mb-5 break-all text-sm text-oai-gray-500">{getInsforgeRemoteUrl()}</p>
      {current.showLocalCloudSync?<CloudSyncRow settings={current}/>:null}
      {current.signedIn?<SyncDevices auth={{user:{id:current.userId},getAccessToken:current.getAccessToken}} machineLimit={null} selfHosted/>:<p>{copy("personal.sync.sign_in")}</p>}
      {current.signedIn ? <div className="mt-5"><CloudUsageExport compact /></div> : null}
    </SectionCard>
    <PricingSection auth={current.getAccessToken} signedIn={current.signedIn}/>
  </div>;
}
export function CloudSyncRow({settings}) { return <div className="mb-5 flex min-h-11 flex-wrap items-center justify-between gap-3 border-b border-oai-gray-200 pb-4 dark:border-oai-gray-800">
  <span className="text-sm font-medium">{copy("settings.account.cloudSync")}</span>
  <ToggleSwitch checked={settings.cloudSyncOn} disabled={settings.cloudSyncPending} onChange={settings.handleCloudSyncToggle} ariaLabel={copy("settings.account.cloudSync")}/>
  {settings.cloudSyncPending?<p role="status" className="w-full text-sm text-oai-gray-500">{copy("settings.account.cloudSyncPending")}</p>:null}
  {settings.cloudSyncError?<div role="alert" className="w-full text-sm text-red-600">{copy("settings.account.cloudSyncError")}<Button variant="ghost" onClick={settings.handleCloudSyncRetry}>{copy("shared.action.retry")}</Button></div>:null}
</div>; }
