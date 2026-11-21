const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {createIntegration, hash} = require('../src/crmIntegration');
const reference='4bcde000-1234-4234-8234-0123456789ab', key='a'.repeat(64);
const period={from:'2026-11-01',to:'2026-11-07'};

test('only an exact non-revoked tenant/account link authorizes a hashed read key', async()=>{
  const calls=[];
  const service=createIntegration({db:{query:async(sql,args)=>{calls.push({sql,args});return {rows:[]};}}});
  await assert.rejects(service.authorize(reference,'session-jwt'),{statusCode:401});
  assert.equal(calls.length,0);
  await assert.rejects(service.authorize(reference,key),{statusCode:401});
  assert.deepEqual(calls[0].args,[reference,hash(key)]);
  for(const condition of ['c.id=t.client_id','c.agency_id=t.agency_id','c.meta_account_id=t.meta_account_id','t.revoked_at IS NULL']) assert(calls[0].sql.includes(condition));
});

test('daily spend crosses pagination without leaking token or double-counting lead aliases',async()=>{
  const calls=[];
  const source=createIntegration({db:{},env:{},fetchImpl:async(url,options)=>{
    calls.push({url,options});
    const payload=!url.pathname.endsWith('/insights')?{currency:'BRL',timezone_name:'America/Sao_Paulo'}:
      url.searchParams.has('after')?{data:[{date_start:period.to,spend:'20.20',clicks:'3',impressions:'60'}]}:
      {data:[{date_start:period.from,spend:'10.10',clicks:'2',impressions:'40',actions:[{action_type:'lead',value:'4'},{action_type:'onsite_conversion.lead_grouped',value:'4'}]}],paging:{next:'https://untrusted.invalid',cursors:{after:'cursor'}}};
    return {ok:true,json:async()=>payload};
  }});
  const result=await source.results({reference,meta_account_id:'123',access_token:'fixture-only'},period);
  assert.equal(result.totals.spend,30.30);assert.equal(result.totals.metaLeads,4);
  assert.equal(result.currency,'BRL');assert.equal(result.days.length,2);
  assert(calls.every(({url,options})=>url.hostname==='graph.facebook.com'&&options.method==='GET'&&!url.searchParams.has('access_token')));
  assert.deepEqual(JSON.parse(calls[1].url.searchParams.get('time_range')),{since:period.from,until:period.to});
  assert(!JSON.stringify(result).includes('fixture-only'));
});

test('provider errors, incomplete metrics and oversized periods never become zero spend',async()=>{
  for(const mode of ['provider','incomplete']){
    const source=createIntegration({db:{},fetchImpl:async url=>({ok:mode!=='provider',json:async()=>mode==='provider'?{error:{message:'private provider details'}}:url.pathname.endsWith('/insights')?{data:[{date_start:period.from,clicks:2,impressions:40}]}:{currency:'BRL',timezone_name:'America/Sao_Paulo'}})});
    await assert.rejects(source.results({meta_account_id:'123',access_token:'fixture'},period),e=>e.statusCode===502&&!e.message.includes('private'));
  }
  const source=createIntegration({db:{},fetchImpl:()=>assert.fail('No request for invalid dates')});
  for(const p of [{from:'2026-02-30',to:'2026-03-01'},{from:'2026-01-01',to:'2026-12-01'}]) await assert.rejects(source.results({},p),{statusCode:400});
});

function routerFixture(enabled){
  const routes={},middleware=[];let authorizations=0;
  const router={use:fn=>middleware.push(fn),get:(route,fn)=>{routes[route]=fn;}};
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/routes/crm-integration.js'),'utf8'),{module,process:{env:{CRM_READ_INTEGRATION_ENABLED:enabled?'true':'false'}},require(name){
    if(name==='express')return {Router:()=>router};
    if(name==='../config/db')return {};
    if(name==='../crmIntegration')return {createIntegration:()=>({authorize:async()=>{authorizations++;return {reference,client_id:8,agency_id:3,access_token:'never-public'};},results:async()=>({totals:{spend:30.30}})})};
    throw Error(name);
  }});
  const res={headers:{},statusCode:200,set(k,v){this.headers[k]=v;return this;},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};
  return {routes,middleware,res,count:()=>authorizations};
}
test('rollout defaults closed before authorization and exposes only two read routes',()=>{
  const f=routerFixture(false);f.middleware[0]({},f.res,()=>assert.fail('disabled'));
  assert.equal(f.res.statusCode,503);assert.equal(f.count(),0);
  assert.deepEqual(Object.keys(f.routes),['/identity','/results']);
  assert.equal(f.res.headers['Cache-Control'],'private, no-store');
});
test('identity response discloses neither Meta token nor account credentials',async()=>{
  const f=routerFixture(true);
  await f.routes['/identity']({get:()=>'',query:{}},f.res);
  assert.equal(f.res.body.reference,reference);assert.equal(f.res.body.accountLinked,true);
  assert(!JSON.stringify(f.res.body).includes('never-public'));
});
