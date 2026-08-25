/**
 * Fachada estável do cliente HTTP do admin.
 *
 * R11: a implementação vive por domínio em `./admin-api/*`; as telas continuam
 * importando deste arquivo para não acoplar UI à organização interna.
 */
export type { Resposta } from './admin-api/core';
export * from './admin-api/conta';
export * from './admin-api/operacao';
export * from './admin-api/agenda';
export * from './admin-api/financeiro-operacional';
export * from './admin-api/clientes';
export * from './admin-api/governanca';
export * from './admin-api/produto';
export * from './admin-api/financeiro';
export * from './admin-api/crescimento';
export * from './admin-api/plataforma';
