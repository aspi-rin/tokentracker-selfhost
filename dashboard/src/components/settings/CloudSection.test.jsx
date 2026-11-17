vi.mock("../cloud/CloudUsageExport.jsx",()=>({CloudUsageExport:()=>null}));
import React from 'react';
import {render,screen,cleanup} from '@testing-library/react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {CloudSection} from './CloudSection.jsx';
import {setCopyLocale} from '../../lib/copy';
const state=vi.hoisted(()=>({hook:vi.fn()}));
vi.mock('./useAccountProfileSettings.js',()=>({useAccountProfileSettings:state.hook}));
vi.mock('../../lib/insforge-config',()=>({getInsforgeRemoteUrl:()=> 'https://personal.example'}));
vi.mock('./SyncDevices.jsx',()=>({SyncDevices:()=> <div data-testid="devices"/>}));
vi.mock('./PricingSection.jsx',()=>({PricingSection:()=> <div data-testid="pricing"/>}));
beforeEach(()=>{setCopyLocale('en');state.hook.mockReset().mockReturnValue({signedIn:false});});afterEach(cleanup);
it('shares provided settings and hides an inactive panel',()=>{
 const v=render(<CloudSection settings={{signedIn:true}}/>);expect(screen.getByTestId('devices')).toBeInTheDocument();expect(screen.getByTestId('pricing')).toBeInTheDocument();expect(state.hook).not.toHaveBeenCalled();
 v.rerender(<CloudSection settings={{signedIn:true}} active={false}/>);expect(screen.queryByTestId('devices')).not.toBeInTheDocument();
});
it('keeps personal sync sign-in guidance for a guest',()=>{render(<CloudSection/>);expect(state.hook).toHaveBeenCalledTimes(1);expect(screen.queryByTestId('devices')).not.toBeInTheDocument();expect(screen.getByText(/Sign in/)).toBeInTheDocument();expect(screen.queryByText(/trial|purchase/i)).not.toBeInTheDocument();});
