// Demo dataset for seed-ai.ts — AI agents, knowledge, memory and usage. Pure data, no logic.

export const DEMO_AGENTS = [
  {
    name: "SDR Bosun",
    specialty: "Qualificação de leads inbound",
    status: "active",
    systemPrompt:
      "Você é o SDR do Bosun. Qualifique o prospect: porte da empresa, canal principal (WhatsApp/site), volume de atendimentos e dor atual. Responda em pt-BR, frases curtas, tom consultivo. Nunca prometa desconto — encaminhe pro humano.",
    businessRules:
      "Planos: Starter R$149/mês (até 5 atendentes), Pro R$299/mês (IA + automações), Enterprise sob consulta. Trial 14 dias sem cartão.",
    signatureLine: "Equipe Bosun",
  },
  {
    name: "Suporte N1",
    specialty: "Dúvidas de configuração e canais",
    status: "draft",
    systemPrompt:
      "Você é o suporte N1 do Bosun. Ajude com conexão de canais (WAHA, Meta Cloud, site chat), convites de membros e permissões. Escale para humano quando envolver cobrança ou dado sensível.",
  },
] as const;

export const DEMO_KNOWLEDGE = [
  {
    title: "Planos e preços do Bosun",
    content:
      "Starter — R$149/mês: até 5 atendentes, WhatsApp + site chat, funil de vendas. Pro — R$299/mês: tudo do Starter + agentes de IA, automações e integrações ilimitadas. Enterprise — sob consulta: multi-unidade, SLA e onboarding dedicado. Anual: 2 meses grátis.",
  },
  {
    title: "Trial de 14 dias",
    content:
      "Todo plano tem 14 dias grátis sem cartão de crédito. Ao final do trial, os dados ficam preservados por 30 dias — basta assinar para continuar de onde parou.",
  },
  {
    title: "Integração WhatsApp",
    content:
      "O Bosun conecta WhatsApp por WAHA (QR code, ideal para começar) ou Meta Cloud API (oficial, para escala). Várias conexões coexistem e podem ser roteadas por setor.",
  },
  {
    title: "Isolamento de dados (multi-tenant)",
    content:
      "Cada organização tem isolamento de dados em camada de aplicação + Row Level Security no Postgres. Membros só veem a org ativa; admins de plataforma não veem conteúdo de conversas.",
  },
] as const;

export const DEMO_MEMORY = [
  {
    type: "faq_gap",
    content:
      "Prospects perguntam recorrentemente sobre NF-e — hoje não emitimos nota fiscal; resposta padrão é encaminhar ao financeiro.",
    confidence: "medium",
    staleAfterDays: 90,
  },
  {
    type: "persona",
    content:
      "Leads pequenos (1-5 pessoas) perguntam primeiro de preço e depois de trial; responder nessa ordem converte melhor.",
    confidence: "high",
    staleAfterDays: 120,
  },
] as const;

export const DEMO_USAGE = [
  {
    callKind: "observer_scan",
    provider: "openrouter",
    model: "openai/gpt-5-mini",
    tokensIn: 4200,
    tokensOut: 640,
    latencyMs: 3100,
    daysAgo: 1,
  },
  {
    callKind: "reply_suggestion",
    provider: "openrouter",
    model: "openai/gpt-5-mini",
    tokensIn: 1800,
    tokensOut: 220,
    latencyMs: 1400,
    daysAgo: 1,
  },
  {
    callKind: "reply_suggestion",
    provider: "openrouter",
    model: "openai/gpt-5-mini",
    tokensIn: 1650,
    tokensOut: 190,
    latencyMs: 1250,
    daysAgo: 2,
  },
  {
    callKind: "observer_scan",
    provider: "openrouter",
    model: "openai/gpt-5-mini",
    tokensIn: 3900,
    tokensOut: 700,
    latencyMs: 2900,
    daysAgo: 3,
  },
  {
    callKind: "draft_review",
    provider: "openrouter",
    model: "openai/gpt-5-mini",
    tokensIn: 2100,
    tokensOut: 310,
    latencyMs: 1600,
    daysAgo: 4,
  },
  {
    callKind: "reply_suggestion",
    provider: "openrouter",
    model: "openai/gpt-5-mini",
    tokensIn: 1500,
    tokensOut: 0,
    latencyMs: 800,
    status: "error",
    daysAgo: 5,
  },
] as const;
