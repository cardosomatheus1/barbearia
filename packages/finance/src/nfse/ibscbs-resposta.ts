import { registro } from './transporte.js';

function centesimos(v: unknown): bigint | null {
  if (typeof v !== 'string' || !/^\d{1,15}\.\d{2}$/.test(v)) return null;
  return BigInt(v.replace('.', ''));
}

/** Recebe somente o fragmento autenticado, já validado no XSD. */
export function respostaIbsCbsConfere(inf: Record<string, unknown>, dps: Record<string, unknown>): boolean {
  // E1515/E1517: o grupo de saída deve acompanhar a declaração da DPS.
  if (Object.hasOwn(inf, 'IBSCBS') !== Object.hasOwn(dps, 'IBSCBS')) return false;
  if (!Object.hasOwn(dps, 'IBSCBS')) return true;
  const rtc = registro(inf['IBSCBS']); const valores = registro(rtc['valores']);
  const totais = registro(rtc['totCIBS']); const ibs = registro(totais['gIBS']); const cbs = registro(totais['gCBS']);
  const municipal = registro(inf['valores']); const declarados = registro(dps['valores']);
  const bruto = centesimos(registro(declarados['vServPrest'])['vServ']);
  const desconto = centesimos(registro(declarados['vDescCondIncond'])['vDescIncond'] ?? '0.00');
  const iss = centesimos(municipal['vISSQN'] ?? '0.00');
  const base = centesimos(valores['vBC']); const liquido = centesimos(municipal['vLiq']);
  const total = centesimos(totais['vTotNF']); const totalIbs = centesimos(ibs['vIBSTot']);
  const totalCbs = centesimos(cbs['vCBS']);
  if (bruto === null || desconto === null || iss === null || base === null || liquido === null ||
    total === null || totalIbs === null || totalCbs === null) return false;
  // Este perfil não declara PIS/COFINS, retenções, repasses, créditos ou reduções.
  // A autoridade escolhe as alíquotas; aqui se confere a coerência dos seus valores.
  if (base !== bruto - desconto - iss || liquido !== bruto - desconto ||
    centesimos(valores['vCalcReeRepRes'] ?? '0.00') !== 0n ||
    rtc['cLocalidadeIncid'] !== registro(registro(dps['serv'])['locPrest'])['cLocPrestacao']) return false;
  const parcelas = [
    { grupo: registro(valores['uf']), taxa: 'pIBSUF', efetiva: 'pAliqEfetUF', valor: registro(ibs['gIBSUFTot'])['vIBSUF'] },
    { grupo: registro(valores['mun']), taxa: 'pIBSMun', efetiva: 'pAliqEfetMun', valor: registro(ibs['gIBSMunTot'])['vIBSMun'] },
    { grupo: registro(valores['fed']), taxa: 'pCBS', efetiva: 'pAliqEfetCBS', valor: cbs['vCBS'] },
  ];
  for (const p of parcelas) {
    const taxa = centesimos(p.grupo[p.taxa]); const efetiva = centesimos(p.grupo[p.efetiva]); const valor = centesimos(p.valor);
    if (taxa === null || efetiva === null || valor === null || taxa !== efetiva) return false;
    const calculado = (base * taxa + 5000n) / 10000n;
    // As regras de totalização admitem diferença de um centavo por arredondamento.
    if (valor < calculado - 1n || valor > calculado + 1n) return false;
  }
  const uf = centesimos(registro(ibs['gIBSUFTot'])['vIBSUF']);
  const mun = centesimos(registro(ibs['gIBSMunTot'])['vIBSMun']);
  if (uf === null || mun === null || totalIbs !== uf + mun) return false;
  return total === (String(dps['dCompet']) < '2027-01-01' ? liquido : liquido + totalIbs + totalCbs);
}
