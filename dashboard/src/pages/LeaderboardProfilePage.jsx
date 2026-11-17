import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import { copy } from "../lib/copy";
import { useCurrency } from "../hooks/useCurrency.js";
import { useTheme } from "../hooks/useTheme.js";
import { ThemeToggle } from "../ui/foundation/ThemeToggle.jsx";
import {
  ProfileContent,
  ProfileSkeleton,
  useLeaderboardProfileData,
} from "../components/leaderboard/LeaderboardProfileModal.jsx";


/**
 * Standalone, shareable per-user profile page at /u/:userId. Reuses the same
 * content + data hook as the leaderboard modal; renders inside a centered
 * card with its own page chrome instead of a dialog. Public profiles are
 * visible to anonymous visitors (the edge function gates per target).
 */
export function LeaderboardProfilePage({ auth, signedIn, sessionSoftExpired, userId }) {
  const { currency, rate } = useCurrency();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const authTokenAllowed = signedIn && !sessionSoftExpired;
  const accessToken = useMemo(() => {
    if (!authTokenAllowed) return null;
    if (typeof auth === "function") return auth;
    if (typeof auth === "string") return auth;
    if (auth && typeof auth === "object") return auth;
    return null;
  }, [auth, authTokenAllowed]);

  const state = useLeaderboardProfileData({ userId, period: "total", accessToken });

  return (
    <main className="min-h-screen bg-oai-gray-50 px-4 py-6 font-oai text-oai-black antialiased dark:bg-oai-gray-950 dark:text-oai-white">
      <div className="mx-auto max-w-3xl">
        <header className="mb-6 flex min-h-11 items-center justify-between gap-3">
          <Link to="/" className="text-sm font-semibold no-underline">{copy("personal.home.title")}</Link>
          <Link to={signedIn?"/dashboard":"/login"} className="inline-flex min-h-10 items-center rounded-lg border border-oai-gray-200 px-4 text-sm no-underline dark:border-oai-gray-800">{copy(signedIn?"nav.usage":"header.auth.sign_in_aria")}</Link>
        </header>
        <section className="overflow-hidden rounded-2xl bg-white ring-1 ring-oai-gray-200 dark:bg-oai-gray-950 dark:ring-oai-gray-800">
          {state.loading ? <ProfileSkeleton variant="page" /> : state.error || !state.data ? <p role="status" className="p-8 text-sm text-oai-gray-500">{copy(state.error?"leaderboard.profile_modal.error":"personal.home.private")}</p>
            : <ProfileContent data={{...state.data,user:{...state.data.user,rank:null,pro_active:false}}} currency={currency} rate={rate} variant="page" />}
        </section>
        <footer className="mt-6 flex justify-end"><ThemeToggle theme={theme} resolvedTheme={resolvedTheme} onSetTheme={setTheme} direction="up" align="right" /></footer>
      </div>
    </main>
  );
}
