const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createLocalApiHandler}=require('../src/lib/local-api');
test('removed skills management rejects reads and writes while retaining user files',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'removed-skills-'));
 try{
  const keep=path.join(dir,'SKILL.md');await fs.writeFile(keep,'User-owned skill\n');
  const handler=createLocalApiHandler({queuePath:path.join(dir,'queue.jsonl'),trackerDataDir:dir});
  for(const pathname of ['/functions/tokentracker-skills','/functions/tokentracker-pets','/api/pets/import'])for(const method of ['GET','POST','DELETE']){
   let body='',status=200;const res={setHeader(){},writeHead(n){status=n},end(v){body+=v||''}};
   await handler({method,headers:{}},res,new URL('http://localhost'+pathname));
   assert.equal(status,410);assert.equal(JSON.parse(body).error,'feature_removed');
  }
  assert.equal(await fs.readFile(keep,'utf8'),'User-owned skill\n');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
