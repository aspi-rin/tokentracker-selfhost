"use strict";
// Compatibility hook for the startup lifecycle; personal builds show no promotion.
async function maybeShowStarCta() { return {shown:false,reason:"personal_instance"}; }
module.exports={maybeShowStarCta};
