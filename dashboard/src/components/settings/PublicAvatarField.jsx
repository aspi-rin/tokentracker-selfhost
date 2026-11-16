import React, { useEffect, useRef, useState } from "react";
import { copy } from "../../lib/copy";
import { Button } from "../../ui/components/Button.jsx";
import { LeaderboardAvatar } from "../LeaderboardAvatar.jsx";
import { prepareAvatarFile } from "./avatar-file.js";

export function PublicAvatarField({ avatar, name }) {
  const input = useRef(null);
  const active = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const disabled = busy || avatar.disabled;
  async function upload(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || disabled) return;
    setBusy(true); setError(false);
    try {
      const data = await prepareAvatarFile(file);
      if (active.current) await avatar.save(data);
    } catch { if (active.current) setError(true); }
    finally { if (active.current) setBusy(false); }
  }
  return <div className="py-3">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex min-w-0 flex-1 basis-48 items-center gap-3">
        <LeaderboardAvatar avatarUrl={name.anonymousOn ? null : avatar.url} displayName={(!name.anonymousOn && name.customDisplayName) || copy("leaderboard.anon_label")} size="lg" />
        <div className="min-w-0">
          <div className="text-sm text-oai-gray-900 dark:text-oai-gray-200">{copy("settings.account.avatar")}</div>
          <p className="mt-0.5 text-xs text-oai-gray-500 dark:text-oai-gray-400">{copy("settings.account.avatarHint")}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" aria-label={copy("settings.account.avatarUpload")} className="sr-only" disabled={disabled} onChange={upload} />
        <Button variant="secondary" size="sm" className="min-h-10" disabled={disabled} onClick={() => input.current?.click()}>
          {copy(busy ? "settings.account.saving" : "settings.account.avatarUpload")}
        </Button>
        {avatar.url ? <Button variant="ghost" size="sm" className="min-h-10" disabled={disabled} onClick={() => avatar.save(null)}>{copy("settings.account.avatarRemove")}</Button> : null}
      </div>
    </div>
    {error ? <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{copy("settings.account.avatarInvalid")}</p> : null}
  </div>;
}
