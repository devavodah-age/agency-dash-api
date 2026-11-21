// Run deliberately in the dashboard API environment, never during startup.
require('dotenv').config();
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const db=require('../src/config/db');
async function main(){
  const id=Number(process.argv[2]);
  if(!Number.isSafeInteger(id)||id<1)throw Error('Uso: node scripts/create-crm-link.cjs CLIENT_ID [--revoke]');
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    const row=(await client.query('SELECT id,agency_id,meta_account_id FROM clients WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!row||!/^\d+$/.test(row.meta_account_id||'')||!row.agency_id)throw Error('Cliente sem conta de anúncios válida.');
    await client.query(fs.readFileSync(path.join(__dirname,'../migrations/crm-read-links.sql'),'utf8'));
    if(process.argv.includes('--revoke')){
      await client.query('UPDATE crm_read_links SET revoked_at=NOW() WHERE client_id=$1',[id]);await client.query('COMMIT');console.log('Acesso de leitura revogado.');return;
    }
    const reference=crypto.randomUUID(),key=crypto.randomBytes(32).toString('hex');
    const hash=crypto.createHash('sha256').update(key).digest('hex');
    await client.query(`INSERT INTO crm_read_links(reference,client_id,agency_id,meta_account_id,access_key_hash)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(client_id) DO UPDATE SET reference=EXCLUDED.reference,
      agency_id=EXCLUDED.agency_id,meta_account_id=EXCLUDED.meta_account_id,access_key_hash=EXCLUDED.access_key_hash,revoked_at=NULL,created_at=NOW()`,[reference,row.id,row.agency_id,row.meta_account_id,hash]);
    await client.query('COMMIT');
    console.log(JSON.stringify({reference,key,note:'Credencial exclusiva de leitura. Salve em Resultados > Conexões no CRM; não adicione ao Git.'},null,2));
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
main().catch(()=>{console.error('Não foi possível configurar a conexão. Confira o cliente, as permissões e o banco.');process.exitCode=1;}).finally(()=>db.end());
