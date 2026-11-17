const {test}=require("node:test");
const assert=require("node:assert/strict");
const {maybeShowStarCta}=require("../src/lib/star-cta");
test("personal startup does not print a promotion",async()=>{
  const result=await maybeShowStarCta({stdout:{isTTY:true,write(){throw Error("unexpected output")}}});
  assert.equal(result.shown,false);
});
