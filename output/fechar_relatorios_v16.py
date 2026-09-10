from pathlib import Path
import json
from inventario_correcao import identidade_da_fonte
root=Path(__file__).resolve().parents[1]
e=root/'output/EVIDENCIAS_CORRECOES_PRE_GO_LIVE'
r=json.loads((e/'regressao-final-v16-resumo.json').read_text())
v=json.loads((e/'validacoes-fonte-v16.json').read_text())
assert r['exit_code']==0 and r['fonte_estavel']
assert v['concluidas']==v['previstas'] and all(x['exit_code']==0 for x in v['etapas'])
assert r['fonte_sha256']==v['fonte_sha256']==identidade_da_fonte()['sha256_conjunto']
assert not r['total_vitest']['failed'] and not r['total_tap']['fail'] and not r['total_dotnet']['failed']
resumo=f"{r['total_vitest']['passed']} Vitest, {r['total_tap']['pass']} TAP e {r['total_dotnet']['passed']} C# aprovados; {len(r['etapas'])} etapas e {len(r['guardas_iniciais'])} guardas iniciais; {v['concluidas']} ensaios complementares concluídos"
rel=root/'output/RELATORIO_ENTREGA_PRE_GO_LIVE.md'
s=rel.read_text().replace('Status: **validação integral em andamento; entrega ainda não encerrada**.','Status: **implementação e validações locais concluídas; publicação final em preparação**.')
s=s.replace('Este relatório deve receber o resultado da regressão v16 e dos complementares\nantes de autorizar uma declaração de conclusão local.',f'Regressão integral v16: {resumo}. Fonte: `{r["fonte_sha256"]}`.')
s=s.replace('Regressão completa v16, Docker/Compose final e complementares: **pendentes de\nconclusão**. Resultados anteriores e tentativas interrompidas estão preservados;\nnão são usados como aprovação da fonte final.', 'Regressão completa v16, Docker/Compose da imagem final e complementares: **aprovados**. Os resumos de comandos/resultados estão em `EVIDENCIAS_CORRECOES_PRE_GO_LIVE/regressao-final-v16-resumo.json` e `validacoes-fonte-v16.json`. Resultados anteriores e tentativas interrompidas permanecem registrados e não são usados como aprovação da fonte final.')
rel.write_text(s)
p=root/'output/STATUS_PRE_GO_LIVE_ATUAL.md';s=p.read_text().replace('Regressão completa **v16 em andamento**; publicação final ainda pendente.', f'Validação completa **v16 aprovada**: {resumo}. Publicação final em preparação.');p.write_text(s)
p=root/'output/PENDENCIAS_PRE_GO_LIVE_ATUAIS.md';s=p.read_text().replace('A regressão integral v16 está em andamento. Docker/Compose, percursos sobre a fonte final, medição, restauração, rollback, backup cifrado, fuso, segredos e dependências serão consolidados no relatório final.',f'A regressão integral v16 e os complementares foram aprovados: {resumo}. Docker/Compose, percursos da fonte final, medição, restauração, rollback, backup cifrado, fuso, segredos e dependências estão consolidados no relatório final.');p.write_text(s)
p=root/'output/AVALIACAO_FLUXO_WHATSAPP.md';s=p.read_text().replace('Status: revisão e percursos finais em andamento.','Status: revisão e percursos locais concluídos.').replace('## Evidência a consolidar','## Evidência concluída')
s=s.replace('O primeiro percurso Meta passou com API/web/banco reais e transporte sintético, incluindo submissão de mensagem, campanha, automação e distinção entre aceitação, entrega e leitura. A conferência visual levou à remoção adicional de instruções duplicadas. A versão final ainda será conferida nos três caminhos em 360, 390, 768 e 1280 px.', 'Os percursos da fonte final passaram com API/web/banco reais e transportes sintéticos: Meta padrão e coexistência, Baileys com worker real, campanhas, automações e fila manual. Foram exercitados erros, expiração do QR, retorno à conexão Meta, retomada da conversa, confirmação manual e opt-out. As telas foram conferidas em 360, 390, 768 e 1280 px. A conferência visual levou à remoção de instruções duplicadas.\n\nMinha avaliação: a escolha inicial agora permite decidir sem conhecer previamente as APIs. A Meta é o caminho mais trabalhoso no cadastro, mas a próxima ação fica indicada. Baileys tem uma sequência curta de QR, mensagem e envio, com o risco visível. Manual é o caminho mais simples para começar, desde que a equipe mantenha a rotina de voltar e confirmar o envio. A avaliação foi feita por mim percorrendo a interface; não é um estudo de usabilidade com clientes externos.')
p.write_text(s)
print(resumo)
