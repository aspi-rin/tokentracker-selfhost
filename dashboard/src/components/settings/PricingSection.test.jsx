import React from 'react';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {PricingSection} from './PricingSection.jsx';
import {setCopyLocale} from '../../lib/copy';
const state=vi.hoisted(()=>({request:vi.fn(),local:false}));
vi.mock('../../lib/insforge-config',()=>({getInsforgeRemoteUrl:()=> 'https://personal.example',getInsforgeAnonKey:()=> 'public-key'}));
vi.mock('../../lib/cloud-billing',()=>({cloudBillingRequest:state.request}));
vi.mock('../../lib/host-mode',()=>({isLocalDashboardHost:()=>state.local}));
vi.mock('../../lib/local-api-auth',()=>({getLocalApiAuthHeaders:async()=> ({'x-tokentracker-local-auth':'local-test'})}));
const catalog={version:'a'.repeat(64),updatedAt:'2026-11-17T00:00:00Z',source:'Reviewed fixture'};
beforeEach(()=>{setCopyLocale('en');state.local=false;state.request.mockReset();vi.stubGlobal('fetch',vi.fn(async()=>Response.json(catalog)));});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('refreshes through the authenticated instance endpoint and shows the returned version',async()=>{
 state.request.mockResolvedValue({...catalog,version:'b'.repeat(64)});const auth=async()=> 'signed-test-token';
 render(<PricingSection auth={auth} signedIn/>);await screen.findByText('Catalog version: aaaaaaaaaaaa');
 fireEvent.click(screen.getByRole('button',{name:'Refresh prices'}));await screen.findByText('Catalog version: bbbbbbbbbbbb');
 expect(state.request).toHaveBeenCalledWith('refresh',{auth,body:{},functionName:'tokentracker-pricing'});
});
it('retains the prior version on failure and warns about an older local client',async()=>{
 state.local=true;fetch.mockImplementation(async url=>url.startsWith('/')?new Response('',{status:404}):Response.json(catalog));state.request.mockRejectedValue(new Error('offline'));
 render(<PricingSection auth={async()=>''} signedIn/>);await screen.findByText('Catalog version: aaaaaaaaaaaa');
 await screen.findByRole('status');fireEvent.click(screen.getByRole('button',{name:'Refresh prices'}));await screen.findByRole('alert');
 expect(screen.getByText('Catalog version: aaaaaaaaaaaa')).toBeInTheDocument();
});
it('allows visitors to read provenance and keeps publication controls disabled',async()=>{
 render(<PricingSection signedIn={false}/>);await screen.findByText('Catalog version: aaaaaaaaaaaa');expect(screen.getByRole('button',{name:'Refresh prices'})).toBeDisabled();expect(state.request).not.toHaveBeenCalled();
});
