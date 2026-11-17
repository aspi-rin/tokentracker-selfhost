import React, { useCallback, useEffect, useRef, useState } from "react";
import { Monitor, Pause, Play } from "lucide-react";
import { cloudBillingRequest } from "../../lib/cloud-billing";
import { clearCloudDeviceSession, isLocalDashboardHost } from "../../lib/cloud-sync-prefs";
import { getLocalApiAuthHeaders } from "../../lib/local-api-auth";
import { copy } from "../../lib/copy";
import { Button } from "../../ui/components/Button.jsx";
const deviceRequest = (action, options) => cloudBillingRequest(action, {...options, functionName:"tokentracker-devices"});
function cloudPlatformLabel(value) { return value || copy("cloud.devices.platform_unknown"); }
function formatCloudDateTime(value) { return new Date(value).toLocaleString(); }
function SyncNotice({ children, error, onRetry }) { return <div role={error?"alert":"status"} className="my-3 text-sm text-oai-gray-500">{error?copy("personal.sync.error"):children}{onRetry?<Button variant="ghost" onClick={onRetry}>{copy("shared.action.retry")}</Button>:null}</div>; }
export function SyncDevices(props) {
  return <ScopedSyncDevices key={props.auth?.user?.id || "guest"} {...props} />;
}
function ScopedSyncDevices({ auth, machineLimit, accountRevision, selfHosted = false }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const actionLock = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const userId = auth?.user?.id;
  const getAccessToken = auth?.getAccessToken;
  const refresh = useCallback(async () => {
    const id = ++generation.current;
    try {
      let currentMachineId;
      if (isLocalDashboardHost()) {
        try {
          const headers = await getLocalApiAuthHeaders();
          const response = await fetch("/functions/tokentracker-machine-id", {
            headers,
          });
          if (response.ok)
            currentMachineId = (await response.json())?.machineId;
        } catch {
          /* Cloud list remains available without local identity. */
        }
      }
      const value = await deviceRequest("devices", {
        auth: getAccessToken,
        params: currentMachineId
          ? { current_machine_id: currentMachineId }
          : {},
      });
      if (id === generation.current) {
        setData(value);
        setError(null);
      }
    } catch (reason) {
      if (id === generation.current)
        setError({ ...reason, code: "billing_devices_unavailable" });
    }
  }, [getAccessToken, userId]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, [refresh, accountRevision]);
  const remove = async (machineId) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await deviceRequest("remove-device", {
        auth: getAccessToken,
        body: { machine_id: machineId },
      });
      if (!mounted.current) return;
      if (
        data?.machines?.find((machine) => machine.machine_id === machineId)
          ?.is_current
      )
        clearCloudDeviceSession();
      setPending(null);
      await refresh();
    } catch (reason) {
      if (mounted.current) setError(reason);
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  };
  const resume = async (machine) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await deviceRequest("resume-device", {
        auth: getAccessToken,
        body: { machine_id: machine.machine_id },
      });
      if (!mounted.current) return;
      if (machine.is_current) clearCloudDeviceSession();
      setNotice(copy("cloud.devices.resumed"));
      await refresh();
    } catch (reason) {
      if (mounted.current) setError(reason);
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  };
  const machines = data?.machines || [];
  const activeCount =
    data?.machine_count ??
    machines.filter((machine) => {
      return machine.status !== "paused";
    }).length;
  const limit = data?.machine_limit ?? machineLimit;
  const hasFreeSlot = limit == null || activeCount < limit;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1">
          <h3 className="text-sm font-semibold">{copy("cloud.devices.title")}</h3>

        </div>
        <span className="text-xs text-oai-gray-500 dark:text-oai-gray-400 tabular-nums">
          {data
            ? limit == null
              ? copy(selfHosted ? "cloud.devices.unlimited_self_hosted" : "cloud.devices.unlimited", { count: activeCount })
              : copy("cloud.devices.count", { count: activeCount, limit })
            : error
              ? copy("cloud.devices.count_unknown")
              : copy("cloud.catalog.loading")}
        </span>
      </div>
      {data?.over_machine_limit || (limit != null && limit < activeCount) ? (
        <div className="mb-4">
          <SyncNotice>{copy("cloud.devices.over_limit")}</SyncNotice>
        </div>
      ) : null}
      {error ? <SyncNotice error={error} onRetry={refresh} context="account" /> : null}
      {notice ? (
        <div className="mb-3">
          <SyncNotice>{notice}</SyncNotice>
        </div>
      ) : null}
      {!error && data && machines.length === 0 ? (
        <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">
          {copy("cloud.devices.empty")}
        </p>
      ) : null}
      {machines.length !== 0 ? (
        <ul className="divide-y divide-oai-gray-200 dark:divide-oai-gray-800">
          {machines.map((machine) => (
            <li key={machine.machine_id} className="py-1.5">
              <div className="grid grid-cols-[17px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
                <Monitor
                  size={17}
                  className="col-start-1 row-start-1 text-oai-gray-500 dark:text-oai-gray-400"
                  aria-hidden
                />
                  <p title={machine.name || copy("cloud.devices.unnamed")} className="col-start-2 row-start-1 min-w-0 truncate text-sm font-medium">
                    {machine.name || copy("cloud.devices.unnamed")}
                  </p>
                  <div className="col-span-2 col-start-2 row-start-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-oai-gray-500 dark:text-oai-gray-400 sm:col-span-1 sm:col-start-2">
                    <span>{cloudPlatformLabel(machine.platform)}</span>
                    <span aria-hidden>·</span>
                    <span>{machine.last_seen_at
                      ? copy("cloud.devices.last_seen", {
                          date: formatCloudDateTime(machine.last_seen_at),
                        })
                      : copy("cloud.devices.last_seen_unknown")}</span>
                    {machine.is_current ? <><span aria-hidden>·</span><span>{copy("cloud.devices.current")}</span></> : null}
                    {machine.status === "paused" ? <><span aria-hidden>·</span><span>{copy("cloud.devices.paused")}</span></> : null}
                  </div>
                  {machine.status === "paused" && !hasFreeSlot ? (
                    <p className="col-start-2 row-start-3 text-xs text-oai-gray-500 dark:text-oai-gray-400">
                      {copy("cloud.devices.no_slot")}
                    </p>
                  ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  className="col-start-3 row-start-1 !min-h-10 !px-2 sm:row-span-2"
                  aria-expanded={machine.status !== "paused" ? pending === machine.machine_id : undefined}
                  aria-controls={pending === machine.machine_id ? `cloud-machine-confirm-${machine.machine_id}` : undefined}
                  onClick={() =>
                    machine.status === "paused"
                      ? resume(machine)
                      : setPending((current) => current === machine.machine_id ? null : machine.machine_id)
                  }
                  disabled={
                    busy || (machine.status === "paused" && !hasFreeSlot)
                  }
                >
                  {machine.status === "paused" ? <Play size={14} className="mr-1.5 shrink-0" aria-hidden /> : <Pause size={14} className="mr-1.5 shrink-0" aria-hidden />}
                  {machine.status === "paused"
                    ? copy("cloud.devices.resume")
                    : copy("cloud.devices.remove")}
                </Button>
              </div>
              {pending === machine.machine_id ? (
                <div id={`cloud-machine-confirm-${machine.machine_id}`} className="mt-3 rounded-lg bg-oai-gray-50 p-3 dark:bg-oai-gray-800">
                  <p className="text-xs leading-5">
                    {copy("cloud.devices.remove_detail")}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => remove(machine.machine_id)}
                      disabled={busy}
                    >
                      {copy("cloud.devices.confirm_remove")}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setPending(null)}
                      disabled={busy}
                    >
                      {copy("cloud.action.keep")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
