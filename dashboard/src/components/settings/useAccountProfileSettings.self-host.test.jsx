import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { publishCloudPromptBilling } from "../../lib/cloud-prompt-policy.js";
import { useAccountProfileSettings } from "./useAccountProfileSettings.js";
const profile = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), token: vi.fn(async () => "synthetic-owner") }));
vi.mock("../../contexts/InsforgeAuthContext.jsx", () => ({ useInsforgeAuth: () => ({
  enabled: true, signedIn: true, user: { id: "private-user", email: "" }, getAccessToken: profile.token,
}) }));
vi.mock("../../lib/insforge-config", () => ({ getInsforgeRemoteUrl: () => "https://private.example", isOfficialInsforgeInstance: () => false }));
vi.mock("../../lib/api", () => ({ getPublicVisibility: profile.get, setPublicVisibility: profile.set }));
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
it("does not query or publish a public profile on a free self-hosted instance", async () => {
  publishCloudPromptBilling("account", { membership: { status: "self_hosted", hosting_mode: "self_hosted", can_read_cloud: true, can_upload_cloud: true } }, "private-user");
  const { result } = renderHook(useAccountProfileSettings);
  expect(result.current.publicProfileAvailable).toBe(false);
  expect(result.current.publicProfileOn).toBe(false);
  await act(async () => { await result.current.handlePublicProfileToggle(); });
  expect(profile.get).not.toHaveBeenCalled();
  expect(profile.set).not.toHaveBeenCalled();
});

it("enables explicit self-hosted public profiles while preserving free membership", async () => {
  vi.stubEnv("VITE_TOKENTRACKER_PUBLIC_PROFILES", "1");
  profile.get.mockResolvedValue({enabled:false,anonymous:false});
  profile.set.mockResolvedValue({enabled:true});
  publishCloudPromptBilling("account", { membership: { status: "self_hosted", hosting_mode: "self_hosted", can_read_cloud: true, can_upload_cloud: true } }, "private-user");
  const { result } = renderHook(useAccountProfileSettings);
  await waitFor(() => expect(profile.get).toHaveBeenCalled());
  expect(result.current.publicProfileAvailable).toBe(true);
  await act(async () => { await result.current.handlePublicProfileToggle(); });
  expect(profile.set).toHaveBeenCalled();
});
