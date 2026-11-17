const fs=require('fs'),path=require('path');
const {chromium}=require('../dashboard/node_modules/playwright');
const frame=require('../TokenTrackerBar/TokenTrackerBar/BotFrames.json').states.idle.frames[0];
(async()=>{const browser=await chromium.launch({headless:true,channel:'chrome'});try{
 const page=await browser.newPage({viewport:{width:64,height:64},deviceScaleFactor:1});
 const points=[];for(let i=0;i<frame.body.length;i+=2)points.push(frame.body[i]+','+frame.body[i+1]);
 const holes=frame.eyes.map(e=>`<rect x="${-e.c[0]}" y="${-e.c[1]}" width="${e.c[0]*2}" height="${e.c[1]*2}" rx="${e.c[2]}" transform="matrix(${e.m.join(' ')})" fill="black"/>`).join('');
 for(const [name,color]of [['onLight','#0a0a0c'],['onDark','#f1efe9'],['linux','#4285f4']]){
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="-125 -125 250 250"><defs><mask id="face"><rect x="-125" y="-125" width="250" height="250" fill="white"/>${holes}</mask></defs><polygon points="${points.join(' ')}" fill="${color}" mask="url(#face)"/></svg>`;
  if(name==='onDark')fs.writeFileSync(path.join(__dirname,'../dashboard/public/bot-menu.svg'),svg+'\n');
  await page.setContent('<html style="background:transparent"><body style="margin:0;background:transparent">'+svg+'</body></html>');
  const png=await page.screenshot({omitBackground:true});
  const head=Buffer.alloc(22);head.writeUInt16LE(1,2);head.writeUInt16LE(1,4);head[6]=64;head[7]=64;head.writeUInt16LE(1,10);head.writeUInt16LE(32,12);head.writeUInt32LE(png.length,14);head.writeUInt32LE(22,18);
  if(name!=='linux')fs.writeFileSync(path.join(__dirname,'../TokenTrackerWin/assets/tray-mascot-'+name+'.ico'),Buffer.concat([head,png]));
  if(name==='linux')fs.writeFileSync(path.join(__dirname,'../TokenTrackerLinux/src-tauri/icons/bot-tray.png'),png);
 }
}finally{await browser.close();}})();
