// Read-only inventory for choosing the pilot. Never print provider credentials.
require('dotenv').config();
const db=require('../src/config/db');
db.query("SELECT id,name,agency_id,(meta_account_id IS NOT NULL AND meta_account_id <> '') AS account_linked FROM clients ORDER BY agency_id,id")
  .then(({rows})=>console.table(rows))
  .catch(()=>{console.error('Não foi possível listar os clientes. Confira o acesso ao banco.');process.exitCode=1;})
  .finally(()=>db.end());
