# Resultados de anúncios no CRM

Esta extensão oferece somente GET /crm-integration/identity e GET /crm-integration/results. Não inicia sincronizações na inicialização, não muda campanhas e não altera as rotas anteriores do dashboard.

## Publicação e piloto

1. Publicar este código com CRM_READ_INTEGRATION_ENABLED ausente ou false. As rotas novas retornam 503; as anteriores seguem iguais. Node 20 ou superior é necessário (fetch e AbortSignal.timeout). Executar `npm run test:crm` antes do deploy.
2. No terminal privado do serviço da API (com suas variáveis existentes), executar `node scripts/list-crm-clients.cjs`. Escolher o ID correto do cliente piloto e confirmar sua agência e conta de anúncios no dashboard. A listagem não mostra tokens.
3. Executar `node scripts/create-crm-link.cjs CLIENT_ID`. Este passo modifica o banco: cria somente a tabela crm_read_links e gera/rotaciona uma chave exclusiva de leitura. Salvar reference e key em local privado. Nunca enviar a chave no chat ou adicionar ao Git. Não executar esse comando durante a inicialização do servidor.
4. Na API do dash, configurar CRM_READ_INTEGRATION_ENABLED=true e META_CRM_GRAPH_VERSION=v27.0 (ou versão homologada no aplicativo Meta). A versão é exclusiva desta extensão; as rotas antigas não mudam. A autorização Meta existente precisa acessar a conta piloto.
5. No backend do CRM, configurar AGENCY_DASH_API_URL com a origem HTTPS da API, sem caminho, e manter TRAFFIC_RESULTS_ENABLED=false enquanto cadastra a conexão. Confirmar o domínio no Railway; não usar o endereço do frontend do dash.
6. No CRM, entrar como administrador master > Resultados de tráfego > Conexões. Selecionar a empresa correta e informar reference e key. O CRM verifica a identidade na API antes de salvar a chave criptografada. A confirmação recente de identidade/2FA continua obrigatória.
7. Ativar TRAFFIC_RESULTS_ENABLED=true no CRM após cadastrar apenas o piloto. Empresas sem vínculo continuam sem dados de anúncios. Conferir investimento, moeda, datas inclusivas e fuso com o Gerenciador de Anúncios para o mesmo período. Confirmar que outro cliente não consegue ver esses dados. Só então cadastrar as demais conexões, uma por empresa.

O CRM já contém os endpoints, o painel e o armazenamento por empresa. O investimento vem do spend da conta de anúncios por dia, não de uma digitação manual. Receita no CRM não implica atribuição à campanha nem recebimento de pagamento. Não exibir ROAS como se todas as vendas viessem de anúncios.

## Reversão e limites

Definir TRAFFIC_RESULTS_ENABLED=false no CRM interrompe as consultas de anúncios e mantém os dados comerciais. CRM_READ_INTEGRATION_ENABLED=false desativa somente as duas rotas novas da API. Desconectar a empresa no CRM elimina sua chave/cache; `node scripts/create-crm-link.cjs CLIENT_ID --revoke` revoga na origem. Cache do CRM: até cinco minutos.

A ausência de resposta ou erro Meta não vira investimento zero. Período máximo de 90 dias. A API guarda hash SHA-256 da chave; o token Meta fica na API da agência. Nenhum segredo JWT é compartilhado entre projetos.

Testes usam apenas dados sintéticos, sem banco de produção e sem chamadas reais à Meta. Homologação de banco, permissões e valores reais é uma etapa separada no piloto.

Referência de versão: https://developers.facebook.com/docs/graph-api/guides/versioning (consultada em 21/11/2026).
