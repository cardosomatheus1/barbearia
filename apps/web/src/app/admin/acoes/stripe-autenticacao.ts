'use server';
import { exigirSessao } from './comum';
import { chamar } from '@/lib/admin-api/core';

type Autenticacao = { estado: 'concluida' | 'aguardando' | 'atualizar_cartao' }
  | { estado: 'autenticar'; chavePublica: string; clientSecret: string; paymentMethod: string };
export async function acaoAutenticarCobranca(faturaId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(faturaId)) {
    return { ok: false as const, message: 'Fatura inválida.' };
  }
  return chamar<Autenticacao>('GET',`/v1/admin/plano/faturas/${faturaId}/autenticacao`,undefined,await exigirSessao());
}
