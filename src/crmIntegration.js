const crypto=require('node:crypto');
const fail=(message,statusCode=502)=>Object.assign(Error(message),{statusCode});
function range(query){
  const valid=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
  if(!valid(query.from)||!valid(query.to)||query.from>query.to||(Date.parse(query.to)-Date.parse(query.from))/86400000>89)throw fail('Período inválido; máximo de 90 dias.',400);
  return {from:query.from,to:query.to};
}
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function actionCount(actions,names){for(const name of names){const action=(actions||[]).find(row=>row.action_type===name);if(action)return nonnegative(action.value);}return 0;}
function nonnegative(value){const n=Number(value??0);if(!Number.isFinite(n)||n<0)throw fail('Métrica indisponível.');return n;}
function normalizeDay(row){if(row.spend==null||row.clicks==null||row.impressions==null)throw fail('Resposta incompleta da Meta.');return {day:row.date_start,spend:nonnegative(row.spend),clicks:nonnegative(row.clicks),impressions:nonnegative(row.impressions),
  metaLeads:actionCount(row.actions,['lead','onsite_conversion.lead_grouped','offsite_conversion.fb_pixel_lead']),
  conversations:actionCount(row.actions,['onsite_conversion.messaging_conversation_started_7d','messaging_conversation_started'])};}
function createIntegration({db,fetchImpl=fetch,env=process.env}) {
  async function authorize(reference,key){
    if(typeof reference!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(reference)||typeof key!=='string'||!/^[a-f0-9]{64}$/i.test(key))throw fail('Conexão não autorizada.',401);
    const {rows}=await db.query(`SELECT t.reference,t.client_id,t.agency_id,t.meta_account_id,
      COALESCE(NULLIF(c.meta_access_token,''),a.meta_access_token) AS access_token
      FROM crm_read_links t JOIN clients c ON c.id=t.client_id AND c.agency_id=t.agency_id AND c.meta_account_id=t.meta_account_id
      JOIN agencies a ON a.id=t.agency_id
      WHERE t.reference=$1 AND t.access_key_hash=$2 AND t.revoked_at IS NULL`,[reference,hash(key)]);
    const link=rows[0];if(!link)throw fail('Conexão não autorizada.',401);
    if(!/^\d+$/.test(link.meta_account_id||'')||!link.access_token)throw fail('Conta de anúncios não configurada.',409);
    return link;
  }
  async function graph(path,token,query={}){
    const version=env.META_CRM_GRAPH_VERSION||'v27.0';
    if(!/^v\d+\.0$/.test(version))throw fail('Versão da integração não configurada.',503);
    const url=new URL(`https://graph.facebook.com/${version}/${path}`);
    for(const [key,value]of Object.entries(query))url.searchParams.set(key,value);
    let response;try{response=await fetchImpl(url,{method:'GET',headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw fail('A Meta está indisponível para consulta.');}
    const payload=await response.json().catch(()=>null);
    if(!response.ok||!payload||payload.error)throw fail('Não foi possível consultar os resultados da Meta.');
    return payload;
  }
  async function results(link,query){
    const period=range(query),account=await graph(`act_${link.meta_account_id}`,link.access_token,{fields:'currency,timezone_name'});
    if(!/^[A-Z]{3}$/.test(account.currency||'')||typeof account.timezone_name!=='string')throw fail('Moeda ou fuso da conta indisponíveis.');
    try{new Intl.DateTimeFormat('pt-BR',{timeZone:account.timezone_name});}catch{throw fail('Fuso da conta indisponível.');}
    const days=[];let after;const seen=new Set();
    for(let page=0;page<10;page++){
      const payload=await graph(`act_${link.meta_account_id}/insights`,link.access_token,{fields:'date_start,date_stop,spend,clicks,impressions,actions',level:'account',time_increment:'1',time_range:JSON.stringify({since:period.from,until:period.to}),limit:'100',...(after?{after}:{})});
      if(!Array.isArray(payload.data))throw fail('Resposta incompleta da Meta.');
      for(const row of payload.data){const day=normalizeDay(row);if(day.day<period.from||day.day>period.to||!/^\d{4}-\d{2}-\d{2}$/.test(day.day||'')||seen.has(day.day))throw fail('Datas inconsistentes da Meta.');seen.add(day.day);days.push(day);}
      if(!payload.paging?.next)break;
      const next=payload.paging?.cursors?.after;
      if(!next||next===after||page===9)throw fail('Consulta incompleta; reduza o período.');after=next;
    }
    const totals={spend:0,clicks:0,impressions:0,metaLeads:0,conversations:0};
    for(const day of days)for(const field of Object.keys(totals))totals[field]+=day[field];
    totals.spend=Math.round(totals.spend*100)/100;
    return {schemaVersion:1,reference:link.reference,...period,currency:account.currency,timezone:account.timezone_name,totals,days:days.sort((a,b)=>a.day.localeCompare(b.day)),updatedAt:new Date().toISOString()};
  }
  return {authorize,results};
}
module.exports={range,hash,normalizeDay,createIntegration};
