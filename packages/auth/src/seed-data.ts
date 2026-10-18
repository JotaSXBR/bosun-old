// Demo dataset for seed-content.ts — pure data, no logic. The Demo org
// pretends to SELL BOSUN through its own channels: prospects ask about
// pricing, WhatsApp integration, multi-tenancy and the trial.

export const DEMO_CONTACTS = [
  {
    key: "marina",
    channelUserId: "5511912340001@c.us",
    displayName: "Marina Souza · Padaria Broma",
  },
  { key: "carlos", channelUserId: "5511912340002@c.us", displayName: "Carlos Tech · CT Telecom" },
  {
    key: "fernanda",
    channelUserId: "5511912340003@c.us",
    displayName: "Fernanda Lima · Studio Flor",
  },
  {
    key: "ricardo",
    channelUserId: "5511912340004@c.us",
    displayName: "Ricardo Alves · Grupo Vetor",
  },
  {
    key: "juliana",
    channelUserId: "5511912340005@c.us",
    displayName: "Juliana Prado · JP Imóveis",
  },
  { key: "paulo", channelUserId: "5511912340006@c.us", displayName: "Paulo Reis · Academia Move" },
  { key: "ana", channelUserId: "5511912340007@c.us", displayName: "Ana Beatriz · AnaDoces" },
  { key: "beto", channelUserId: "5511912340008@c.us", displayName: "Beto Campos · Motos Beto" },
  { key: "luisa", channelUserId: "5511912340009@c.us", displayName: "Luísa Ferraz · LF Contábil" },
  {
    key: "tiago",
    channelUserId: "5511912340010@c.us",
    displayName: "Tiago Nunes · Nunes Advocacia",
  },
] as const;

export const WIDGET_VISITORS = [
  { key: "larissa", email: "larissa@vivafit.com.br", displayName: "Larissa Melo · VivaFit" },
  { key: "diego", email: "diego@ortoclin.com.br", displayName: "Diego Ramos · Ortoclin" },
] as const;

export type ThreadSpec = {
  contactKey: string;
  externalSuffix: string;
  conn: "waha" | "site";
  status: "open" | "in_progress" | "waiting_customer" | "resolved" | "closed";
  sector?: "vendas" | "suporte";
  assigneeRole?: "agent" | "manager" | "owner";
  labels?: Array<"Prioridade" | "Recorrente">;
  snoozedUntil?: Date;
  precededByKey?: string;
  msgs: Array<{
    dir: "inbound" | "outbound";
    text: string;
    daysAgo: number;
    hour?: number;
    status?: "received" | "sent" | "delivered" | "read";
    private?: boolean;
    authorRole?: "agent" | "manager" | "owner";
  }>;
};

export const THREADS_FIRST: ThreadSpec[] = [
  {
    contactKey: "marina",
    externalSuffix: "marina",
    conn: "waha",
    status: "waiting_customer",
    sector: "vendas",
    assigneeRole: "agent",
    labels: ["Recorrente"],
    msgs: [
      {
        dir: "inbound",
        text: "Oi! Vi o Bosun no Instagram. Vocês têm plano para padaria pequena? Somos 3 pessoas no atendimento.",
        daysAgo: 2,
        hour: 9,
      },
      {
        dir: "outbound",
        text: "Oi Marina! Sim — o plano Starter cobre até 5 atendentes com WhatsApp e funil inclusos. Posso te mandar a tabela de preços?",
        daysAgo: 2,
        hour: 9,
        status: "read",
        authorRole: "agent",
      },
      { dir: "inbound", text: "Pode sim! E o site chat entra nesse plano?", daysAgo: 2, hour: 10 },
      {
        dir: "outbound",
        text: "Entra! Widget do site já vem no Starter sem custo extra. A tabela: Starter R$149/mês, Pro R$299/mês com IA e automações.",
        daysAgo: 2,
        hour: 10,
        status: "read",
        authorRole: "agent",
      },
      {
        dir: "outbound",
        text: "Cliente pediu 15 min pra pensar — aguardar retorno amanhã cedo.",
        daysAgo: 2,
        hour: 10,
        status: "sent",
        private: true,
        authorRole: "agent",
      },
      {
        dir: "inbound",
        text: "Vou conversar com meu sócio e te retorno amanhã, tá?",
        daysAgo: 2,
        hour: 11,
      },
    ],
  },
  {
    contactKey: "carlos",
    externalSuffix: "carlos",
    conn: "waha",
    status: "in_progress",
    sector: "vendas",
    assigneeRole: "agent",
    labels: ["Prioridade"],
    msgs: [
      {
        dir: "inbound",
        text: "Bom dia! A integração com WhatsApp do Bosun é via QR code ou API oficial da Meta?",
        daysAgo: 1,
        hour: 8,
      },
      {
        dir: "outbound",
        text: "Bom dia Carlos! As duas: WAHA (QR, não oficial) para começar rápido e Meta Cloud API oficial para escala. Você pluga as duas ao mesmo tempo se quiser.",
        daysAgo: 1,
        hour: 8,
        status: "read",
        authorRole: "agent",
      },
      {
        dir: "inbound",
        text: "Ótimo. E dá pra ter 2 números conectados? Um comercial e um de suporte.",
        daysAgo: 1,
        hour: 9,
      },
      {
        dir: "outbound",
        text: "Dá sim — cada conexão vira um canal separado e você roteia por setor: comercial → time Vendas, suporte → time Suporte.",
        daysAgo: 1,
        hour: 9,
        status: "delivered",
        authorRole: "agent",
      },
      {
        dir: "inbound",
        text: "Show. Quero agendar uma demo quinta de manhã, tem como?",
        daysAgo: 1,
        hour: 9,
      },
    ],
  },
  {
    contactKey: "fernanda",
    externalSuffix: "fernanda",
    conn: "waha",
    status: "open",
    msgs: [
      {
        dir: "inbound",
        text: "Olá! O trial de 14 dias precisa de cartão de crédito?",
        daysAgo: 0,
        hour: 11,
      },
    ],
  },
  {
    contactKey: "ricardo",
    externalSuffix: "ricardo",
    conn: "waha",
    status: "in_progress",
    sector: "vendas",
    assigneeRole: "manager",
    labels: ["Prioridade"],
    msgs: [
      {
        dir: "inbound",
        text: "Temos 3 unidades. O Bosun separa os dados de cada filial? Preciso de isolamento real entre franquias.",
        daysAgo: 3,
        hour: 14,
      },
      {
        dir: "outbound",
        text: "Oi Ricardo! Separa sim — multi-tenant com isolamento por organization no Postgres (RLS em todas as tabelas). Cada franquia pode ser uma organização ou um setor dentro da mesma org, depende do seu modelo.",
        daysAgo: 3,
        hour: 14,
        status: "read",
        authorRole: "manager",
      },
      {
        dir: "inbound",
        text: "E relatórios? Consigo ver funil por unidade?",
        daysAgo: 3,
        hour: 15,
      },
      {
        dir: "outbound",
        text: "Funis são por organização — se cada unidade for uma org, cada uma tem seu pipeline. Se for um grupo só, dá pra segmentar por setor e labels.",
        daysAgo: 3,
        hour: 15,
        status: "read",
        authorRole: "manager",
      },
      {
        dir: "inbound",
        text: "Faz sentido. Manda a proposta Enterprise pra 3 unidades?",
        daysAgo: 2,
        hour: 8,
      },
    ],
  },
  {
    contactKey: "juliana",
    externalSuffix: "juliana",
    conn: "waha",
    status: "waiting_customer",
    sector: "vendas",
    assigneeRole: "owner",
    labels: ["Recorrente"],
    msgs: [
      {
        dir: "inbound",
        text: "Oi! Passando pra lembrar da proposta do plano Pro anual. Tem desconto no anual?",
        daysAgo: 1,
        hour: 16,
      },
      {
        dir: "outbound",
        text: "Oi Ju! Tem sim — anual fica 2 meses grátis (R$2990/ano no Pro). Te mando o link de checkout?",
        daysAgo: 1,
        hour: 16,
        status: "read",
        authorRole: "owner",
      },
      { dir: "inbound", text: "Manda! Vou apresentar pra diretoria sexta.", daysAgo: 1, hour: 17 },
    ],
  },
  {
    contactKey: "paulo",
    externalSuffix: "paulo",
    conn: "waha",
    status: "resolved",
    sector: "suporte",
    assigneeRole: "agent",
    msgs: [
      {
        dir: "inbound",
        text: "Conectei o WhatsApp mas as mensagens não estão chegando na inbox 😕",
        daysAgo: 5,
        hour: 10,
      },
      {
        dir: "outbound",
        text: "Oi Paulo! Vamos verificar: sua sessão WAHA aparece como 'conectado' em Configurações → Canais? Se sim, me diz se o webhook responde 200.",
        daysAgo: 5,
        hour: 10,
        status: "read",
        authorRole: "agent",
      },
      {
        dir: "inbound",
        text: "Era isso! O webhook estava com a URL antiga. Ajustei e já chegou tudo. Obrigado!",
        daysAgo: 5,
        hour: 11,
      },
      {
        dir: "outbound",
        text: "Perfeito! Qualquer coisa chama. Vou resolver o ticket por aqui 🙌",
        daysAgo: 5,
        hour: 11,
        status: "read",
        authorRole: "agent",
      },
    ],
  },
];
