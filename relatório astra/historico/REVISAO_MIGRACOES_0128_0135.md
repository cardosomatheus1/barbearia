# Revisão cumulativa das migrações 0128–0135

Repositório barbearia, 10/09/2026. Leitura SQL e conferência dos consumidores
antes de atualizar HEAD_AUDITADO. Não é aprovação de produção.

| Migração | Garantia e consumidor conferidos | Evidência local |
|---|---|---|
| 0128 | Regime e estimativas com CHECK de faixa/completude; mesmas tabelas/RLS; snapshot fiscal | nfse-apuracao3-banco, 23 cenários |
| 0129 | IBS/CBS explícito; vínculo de serviço/NBS; snapshot e recusa de tomador ausente | Provas IBS/CBS de API, XML e navegador; incluídas na suíte nacional |
| 0130 | Amplia formato de CNPJ; preserva valores existentes; cliente permanece alcançado por LGPD | fiscal-cnpj-confianca-mutacoes e suíte nacional |
| 0131 | Prova cifrada por unidade/documento/tipo; impede apagar ou substituir prova já gravada | Testes de prova-resposta e nacional |
| 0132 | FORCE RLS USING/WITH CHECK, FK unidade/tenant, trigger confere origem/atores, snapshot imutável; limpeza de payload e exportação LGPD | manual-origem-validada: 13 cenários; manual-navegador-pos-revisao |
| 0133 | ISS fora do DAS explícito; estimativas completas quando habilitado; preserva default anterior | nfse-apuracao3-unit e banco |
| 0134 | FORCE RLS USING/WITH CHECK, vínculo cliente/horário/tenant, origem e texto imutáveis; token só hash; expiração e anonimização; trilha do consentimento exportada | consentimento-integridade-api, navegador e revisão da cadeia de retenção |
| 0135 | Federais fora exigem ISS fora; default falso; escolha congelada no snapshot | nfse-apuracao3-unit/banco/api/navegador |

As funções trigger fixam search_path vazio e revogam execução de PUBLIC.
Não há senha, chave privada ou credencial nas migrações. Não há DROP TABLE
ou perda de coluna; 0130 substitui CHECKs para ampliar um formato.

`migracoes-0128-0135-invariantes`: `pnpm --filter @barbearia/db test`, saída 0,
13 s, aplicação de 135 migrações, invariantes SQL cumulativas e 10 casos do
cliente de banco. Os testes específicos acima complementam essas invariantes;
a execução não implica que cada CHECK novo tenha um arquivo SQL individual.

A regressão v8 expôs defasagem de HEAD_AUDITADO em 0127 e da documentação.
A atualização para 0135 registra esta revisão deliberada, não a conclusão do
lançamento. V8 foi interrompida; regressão integral da fonte corrigida continua
obrigatória. O auxiliar confirmou o encadeamento worker → varrerRetencao →
limparPedidosConsentimento e está acrescentando prova específica da exclusão
de intenções expiradas por esse caminho.
