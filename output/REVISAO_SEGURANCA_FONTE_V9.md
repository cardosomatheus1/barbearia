# Revisão dirigida de segurança — fonte v9

10/09/2026. Revisão local; regressão integral ainda em execução. Não é
certificação externa nem afirmação de ausência de vulnerabilidades.

## Invariantes conferidas

- Consentimento: rota autenticada com CustomerGuard; o customerId vem da
  sessão, token aleatório de 32 bytes com hash no banco e validade de 30 min.
  Origem/texto imutáveis, isolamento por RLS, lock do cliente antes do pedido,
  confirmação consumida não reativa preferência revogada. Cinco casos HTTP
  dirigidos aprovados em `consentimento-replay-api`.
- Retenção: limpeza transitiva chamada pelo worker, com prova de expiração
  e isolamento entre tenants em `consentimento-retencao-crm`.
- Manual: StaffGuard/PermissaoGuard e unidade da sessão; fila protegida por
  RLS e validação SQL das referências; reserva por operador, trava da fila e
  chave promocional; texto/telefone cifrados enquanto pendente e apagados na
  conclusão. Abrir wa.me não registra envio. `manual-limiares-browser` exerceu
  confirmação, retomada, automação e opt-out; provas anteriores da migração
  e isolamento permanecem registradas na transferência.
- Fiscal: A1 exige X.509v3 e KeyUsage de assinatura/não repúdio, raiz independente
  do PFX e CRLs de todos os níveis. Resposta exige assinante autorizado e XML
  vinculado à nota; prova histórica cifrada não é apresentada como carimbo do
  tempo. Testes dirigidos A1 e assinatura anteriores preservados.
- Renovação de confiança: manifesto da instalação, pins de CA, limites de
  download, bloqueio de destinos internos/rebinding, sem redirecionamentos;
  publicação atômica após validação de CRLs e sem retrocesso, com lock do kernel.

## Alcance dos resultados

As 29 guardas iniciais da v9 passaram, incluindo invariantes de auditoria,
segurança ofensiva e fronteiras dos módulos. O resultado global depende de
todas as etapas do runner. O escaneamento final de segredos/histórico e a
auditoria de dependências serão registrados separadamente. Nenhum token,
certificado privado, payload de cliente real ou dump integra este relatório.

`git diff --cached --check` apontou somente espaços finais nos XSD oficiais
importados. Eles foram preservados byte a byte para manter o vínculo com o
hash de origem; a mesma verificação excluindo esses XSD saiu 0. Não se alterou
o esquema oficial apenas para normalizar espaços.
