const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
test('personal cold-start HTML keeps native bootstrap and avoids promotional network requests',()=>{
 const html=read('dashboard/index.html');
 assert.match(html,/Object\.hasOwn/);assert.match(html,/nativeBridge/);assert.match(html,/id="root"/);
 assert.doesNotMatch(html,/<img\b[^>]*src="https?:|directory-badges|application\/ld\+json/);
 assert.doesNotMatch(html,/__TOKENTRACKER_/);
});
test('personal product documentation keeps core features and upstream attribution',()=>{
 const doc=read('README.md');assert.match(doc,/multi.*device|multiple computers/);assert.match(doc,/price catalog/);assert.match(doc,/optional public/);assert.match(doc,/MIT/);assert.match(doc,/xiufengsun\/TokenTracker/);
});
test('personal crawler metadata protects app and API entry points',()=>{
 const robots=read('dashboard/public/robots.txt');for(const route of ['/settings','/device','/functions/','/api/'])assert.ok(robots.includes('Disallow: '+route));
});
