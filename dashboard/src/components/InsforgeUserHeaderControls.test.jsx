import React from 'react';
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {InsforgeUserHeaderControls} from './InsforgeUserHeaderControls.jsx';
const state=vi.hoisted(()=>({auth:{},navigate:vi.fn(),login:vi.fn()}));
vi.mock('../contexts/InsforgeAuthContext.jsx',()=>({useInsforgeAuth:()=>state.auth}));
vi.mock('../contexts/LoginModalContext.jsx',()=>({useLoginModal:()=>({openLoginModal:state.login})}));
vi.mock('react-router-dom',()=>({useNavigate:()=>state.navigate}));
vi.mock('../hooks/useLocale.js',()=>({useLocale:()=>{}}));
vi.mock('../lib/native-bridge.js',()=>({isNativeApp:()=>false}));
beforeEach(()=>{state.auth={enabled:true,loading:false,signedIn:true,user:{id:'owner',profile:{avatar_url:'https://avatar.example/photo.png'}},displayName:'Rin'};state.navigate.mockReset();state.login.mockReset();});
afterEach(cleanup);
it.each([true,false])('shows personal identity without membership decoration (collapsed=%s)',collapsed=>{
 render(<InsforgeUserHeaderControls variant="sidebar" collapsed={collapsed}/>);
 expect(screen.queryByText('Pro')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Open settings'}));expect(state.navigate).toHaveBeenCalledWith('/settings');
});
it('keeps identity initials when an avatar fails',()=>{render(<InsforgeUserHeaderControls variant="sidebar"/>);fireEvent.error(screen.getByRole('img'));expect(screen.getByText('RI')).toBeInTheDocument();});
it('opens sign in for a guest',()=>{state.auth.signedIn=false;render(<InsforgeUserHeaderControls/>);fireEvent.click(screen.getByRole('button'));expect(state.login).toHaveBeenCalled();});
