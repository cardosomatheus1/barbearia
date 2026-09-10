/**
 * A migração-cabeça que os exercícios de auditoria cobriram.
 *
 * Três guardas — auditoria final cross-domain, recheck final e certificação
 * prática — travam o head das migrações. O trinco é legítimo e a mensagem dele
 * diz o porquê: *"head de migração mudou sem passar pela auditoria"*. Migração
 * nova é a coisa mais capaz de invalidar uma auditoria de RLS, cascata e dado
 * pessoal, e o trinco existe para ninguém acrescentar uma sem olhar.
 *
 * O valor estava escrito **três vezes**, uma em cada guarda. É a lista paralela
 * que este repositório já viu divergir cinco vezes, e aqui ela tem um agravante:
 * as três só ficam vermelhas juntas, então quem consertasse duas concluiria que
 * a terceira é outro problema.
 *
 * **Subir este número é um ato deliberado**, não um passo mecânico do commit.
 * Quem sobe está afirmando que leu a migração nova contra o que as três guardas
 * protegem: RLS com `USING` e `WITH CHECK`, ação referencial que não amplia
 * acesso nem contorna `REVOKE`, coluna nova de dado pessoal alcançada pela
 * anonimização e pela exportação do titular, e nada de segredo ou credencial.
 *
 * Histórico do que cada subida afirmou:
 *
 * - `0117` — exercícios de auditoria final, recheck e certificação prática.
 * - `0118` — `ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS
 *   'link_atualizado'`. Um valor de enum: sem tabela, sem coluna, sem política,
 *   sem chave estrangeira e sem dado pessoal. Nada do que as três protegem é
 *   tocado, e `notifications` já guarda telefone **mascarado** por decisão do
 *   bloco 20 — o aviso novo não muda isso.
 * - `0119` — `CHECK NOT VALID` em `locations.amenities`. Restringe, não amplia:
 *   nenhuma política, nenhuma cascata, nenhuma coluna nova, nenhum dado pessoal.
 *   `NOT VALID` de propósito, para a criação não varrer a tabela e travar o
 *   deploy contra uma linha legada — o motivo está escrito na migração.
 */
// 0120–0126: cadastro SaaS e reserva financeira com escrita da plataforma;
// fiscal/Baileys com FORCE RLS e FKs compostas; credenciais cifradas;
// rota nota reservada; convite cifrado apagado ao encerrar. Invariantes do
// Postgres reexecutadas em migracoes-0120-0126-db. Não atesta homologação externa.
// 0127: somente descrição do recurso fiscal. Invariantes reexecutadas em migracao-texto-fiscal-db.
// 0128/0129/0133/0135: perfis/percentuais explícitos, CHECKs, sem ampliar acesso.
// 0130: formato alfanumérico sem apagar identificadores fiscais ou dados legados.
// 0131: prova fiscal cifrada, vinculada ao documento e imutável após persistência.
// 0132/0134: fila manual e intenção de aceite com FORCE RLS, origem conferida
// por trigger, payload protegido e alcance por retenção/exportação/anonimização.
// Revisão e provas dirigidas registradas em output/REVISAO_MIGRACOES_0128_0135.md;
// invariantes cumulativas reexecutadas em migracoes-0128-0135-invariantes.
// O head auditado não declara cobertura fiscal universal nem homologação externa.
// 0136: quatro tabelas com FORCE RLS e FKs compostas para unidade/documento;
// contador separado por CNPJ/município/ambiente/série, credenciais e arquivo
// cifrados, primeira resposta imutável e histórico sem UPDATE/DELETE/TRUNCATE.
// Revisão em output/REVISAO_MIGRACAO_0136.md; invariantes cumulativas e 30
// cenários municipais aprovados. Arquivo fiscal não é apagado pelo cadastro.
export const HEAD_AUDITADO = '0136';

/** As migrações que a auditoria cumulativa exige que continuem existindo. */
export const MIGRACOES_AUDITADAS = [
  '0110', '0111', '0112', '0113', '0114', '0115', '0116', '0117',
];
