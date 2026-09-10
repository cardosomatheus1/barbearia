# Revisão da migração municipal 0136

Repositório barbearia, 10/09/2026. Revisão deliberada antes da atualização de
HEAD_AUDITADO; sem aplicação em produção.

- `native_emitter` restringe a escolha a nacional/municipal e preserva o padrão
  nacional. O documento conserva o emissor original mesmo após mudança da unidade.
- As quatro tabelas municipais têm ENABLE/FORCE RLS, USING e WITH CHECK pelo
  tenant da transação. Configuração e documentos usam FKs compostas, que exigem
  unidade, nota e tenant correspondentes. Credenciais e payloads ficam cifrados.
- Contador de RPS é único por CNPJ/município/ambiente/série. Cadastro exige série
  exclusiva e impede alterar seu primeiro número; conflito não autoriza envio.
- Trigger de documento impede substituir identidade, snapshot, pedido, primeira
  resposta, tentativa, XML, protocolo e evento já persistidos. A função fixa
  search_path vazio e revoga execução pública.
- REVOKE explícito neutraliza default privileges: histórico não permite UPDATE,
  DELETE ou TRUNCATE; as demais tabelas não permitem DELETE/TRUNCATE pelo role
  da aplicação. FKs RESTRICT protegem a referência à nota. A cascata de exclusão
  do tenant é operação administrativa, não permissão da aplicação.
- Não há segredo literal, coluna removida, DROP TABLE ou transformação destrutiva.
- Dados do tomador já estão congelados em `fiscal_invoices`, alcançados pela
  exportação LGPD através da venda. O arquivo municipal segue a guarda fiscal
  do arquivo nacional: anonimizar cadastro não reescreve XML autorizado nem o
  histórico cifrado. A representação PDF informa seu caráter auxiliar.

Evidências executadas:

| Comando/registro | Resultado |
|---|---|
| `migracao-0136-invariantes`: `pnpm --filter @barbearia/db test` | Saída 0; 136 migrações aplicadas em banco descartável, invariantes SQL cumulativas e 10 testes do cliente |
| `municipal-integracao-banco-v6`: `pnpm --filter @barbearia/finance test src/nfse-municipal` | Saída 0; 30 testes de contrato/banco, incluindo concorrência, RLS, primeira resposta, histórico, timeout, cancelamento, PDF/XML e IM equivalente/divergente |

A revisão não equivale a homologação municipal ou aprovação de implantação.
