import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getInsforgeAnonKey, getInsforgeRemoteUrl } from "../lib/insforge-config";
import { functionUrlFor, fetchFunctionResponse } from "../lib/function-url";
import { LeaderboardProfilePage } from "./LeaderboardProfilePage.jsx";
import { copy } from "../lib/copy";
import { Button } from "../ui/components/Button.jsx";

export default function PersonalHomePage({ auth, signedIn }) {
  const [state,setState]=useState({loading:true,id:null,error:false});
  useEffect(()=>{
    const controller=new AbortController();
    (async()=>{
      try{
        const response=await fetchFunctionResponse(functionUrlFor(getInsforgeRemoteUrl(),"tokentracker-public-home"),{headers:{apikey:getInsforgeAnonKey()},signal:controller.signal});
        if(!response.ok && response.status!==404)throw Error("Profile unavailable");
        const data=response.ok?await response.json():null;
        if(!controller.signal.aborted)setState({loading:false,id:data?.user_id || null,error:false});
      }catch{if(!controller.signal.aborted)setState({loading:false,id:null,error:true});}
    })();return()=>controller.abort();
  },[]);
  if(state.id)return <LeaderboardProfilePage userId={state.id} auth={auth} signedIn={signedIn} personal />;
  return <main className="nord-profile flex min-h-screen items-center justify-center px-6 py-8 text-center">
    <div className="nord-profile-surface flex w-full max-w-xl flex-col items-center gap-5 px-6 py-8">
      <h1 className="text-balance text-2xl font-semibold">{copy("personal.home.title")}</h1>
      <p role={state.error?"alert":"status"} className="nord-profile-muted text-sm">{copy(state.loading?"shared.loading":state.error?"leaderboard.profile_modal.error":"personal.home.private")}</p>
      <Button as={Link} to={signedIn?"/dashboard":"/login"} variant="secondary" className="nord-profile-control">{copy(signedIn?"nav.usage":"header.auth.sign_in_aria")}</Button>
    </div>
  </main>;
}
