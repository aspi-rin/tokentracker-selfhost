import React from "react";
import { act, render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AccountSection } from "./AccountSection.jsx";
import { setCopyLocale } from "../../lib/copy";
const api = vi.hoisted(() => ({ get:vi.fn(), set:vi.fn(), token:vi.fn(async()=>"synthetic-token") }));
vi.mock("../../contexts/InsforgeAuthContext.jsx",()=>({useInsforgeAuth:()=>({enabled:true,signedIn:true,
  user:{id:"synthetic-owner",profile:{name:"Private account name"}},getAccessToken:api.token})}));
vi.mock("../../lib/insforge-config",()=>({getInsforgeRemoteUrl:()=>"https://private.example",isOfficialInsforgeInstance:()=>false}));
vi.mock("../../lib/api",()=>({getPublicVisibility:api.get,setPublicVisibility:api.set}));
afterEach(()=>{cleanup();vi.unstubAllEnvs();vi.restoreAllMocks();vi.clearAllMocks();});
it("shows the actual unset public name and offers an avatar upload beside nickname editing",async()=>{
  vi.stubEnv("VITE_TOKENTRACKER_PUBLIC_PROFILES","1");setCopyLocale("en");
  vi.spyOn(window,"scrollTo").mockImplementation(()=>{});
  api.get.mockResolvedValue({enabled:true,anonymous:false,display_name:null,avatar_url:null});
  api.set.mockResolvedValue({display_name:"Rin"});
  render(<AccountSection/>);
  await waitFor(()=>expect(screen.getByText("Choose a public nickname")).toBeInTheDocument());
  expect(screen.getByLabelText("Upload avatar")).toHaveAttribute("type","file");
  await act(async()=>{await userEvent.click(screen.getAllByRole("button",{name:"Edit"})[0]);});
  const input=screen.getByPlaceholderText("Display name");
  expect(input).toHaveValue("");
  await act(async()=>{await userEvent.type(input,"Rin");await userEvent.click(screen.getByRole("button",{name:"Save"}));});
  await waitFor(()=>expect(api.set).toHaveBeenCalledWith(expect.objectContaining({display_name:"Rin"})));
  expect(screen.getAllByText("Rin").length).toBeGreaterThan(0);
});
