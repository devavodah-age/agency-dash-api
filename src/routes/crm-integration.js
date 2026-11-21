const router=require('express').Router();
const db=require('../config/db');
const integration=require('../crmIntegration').createIntegration({db});
router.use((_req,res,next)=>{res.set('Cache-Control','private, no-store');if(process.env.CRM_READ_INTEGRATION_ENABLED!=='true')return res.status(503).json({error:'Integração de leitura ainda não liberada.'});next();});
const route=handler=>async(req,res)=>{try{
  const header=req.get('Authorization')||'';
  const link=await integration.authorize(req.get('X-CRM-Link'),header.startsWith('Bearer ')?header.slice(7):'');
  await handler(req,res,link);
}catch(error){res.status(error.statusCode||503).json({error:error.statusCode?error.message:'Integração temporariamente indisponível.'});}};
router.get('/identity',route(async(_req,res,link)=>res.json({schemaVersion:1,reference:link.reference,clientId:link.client_id,agencyId:link.agency_id,accountLinked:true})));
router.get('/results',route(async(req,res,link)=>res.json(await integration.results(link,req.query))));
// No routes for changing campaigns, budgets, ads or Meta authorizations.
module.exports=router;
