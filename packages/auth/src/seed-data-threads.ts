// Demo dataset for seed-threads.ts — second half of the conversations (order matters:
// tickets are numbered in sequence, so these come after THREADS_FIRST). Pure data.
import type { ThreadSpec } from "./seed-data";

export const THREADS_LAST: ThreadSpec[] = [
  {
    contactKey: "ana",
    externalSuffix: "ana-1",
    conn: "waha",
    status: "closed",
    sector: "suporte",
    assigneeRole: "agent",
    msgs: [
      {
        dir: "inbound",
        text: "Como faço pra adicionar uma nova pessoa na minha conta?",
        daysAgo: 12,
        hour: 15,
      },
      {
        dir: "outbound",
        text: "Oi Ana! Configurações → Membros → Convidar — você manda o convite por e-mail e escolhe o papel (owner/admin/manager/agent/viewer).",
        daysAgo: 12,
        hour: 15,
        status: "read",
        authorRole: "agent",
      },
      { dir: "inbound", text: "Achei! Obrigada 🙏", daysAgo: 12, hour: 16 },
    ],
  },
  {
    contactKey: "ana",
    externalSuffix: "ana-2",
    conn: "waha",
    status: "open",
    sector: "suporte",
    assigneeRole: "agent",
    precededByKey: "ana-1",
    msgs: [
      {
        dir: "inbound",
        text: "Oi, sou eu de novo! Agora o site chat parou de mostrar o histórico do visitante, é normal?",
        daysAgo: 0,
        hour: 13,
      },
    ],
  },
  {
    contactKey: "beto",
    externalSuffix: "beto",
    conn: "waha",
    status: "open",
    snoozedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
    msgs: [
      {
        dir: "inbound",
        text: "O Bosun emite nota fiscal? Preciso pra contabilidade.",
        daysAgo: 1,
        hour: 19,
      },
      {
        dir: "outbound",
        text: "Boa pergunta, Beto — vou confirmar com o financeiro e te retorno. Deixo o ticket adiado até amanhã.",
        daysAgo: 1,
        hour: 19,
        status: "delivered",
        authorRole: "agent",
      },
    ],
  },
  {
    contactKey: "larissa",
    externalSuffix: "larissa",
    conn: "site",
    status: "open",
    sector: "vendas",
    msgs: [
      {
        dir: "inbound",
        text: "Oi! Estou no site de vocês. O widget que estou usando agora já é o Bosun?",
        daysAgo: 0,
        hour: 10,
      },
      {
        dir: "outbound",
        text: "É sim, Larissa! Esse chat é o site chat do próprio Bosun — o mesmo que você instalaria no seu site com um snippet.",
        daysAgo: 0,
        hour: 10,
        status: "delivered",
        authorRole: "agent",
      },
      {
        dir: "inbound",
        text: "Que legal! E o visitante precisa criar conta pra conversar?",
        daysAgo: 0,
        hour: 10,
      },
    ],
  },
  {
    contactKey: "diego",
    externalSuffix: "diego",
    conn: "site",
    status: "open",
    msgs: [
      {
        dir: "inbound",
        text: "Boa tarde, vocês têm API pública pra integrar o Bosun com meu ERP?",
        daysAgo: 1,
        hour: 15,
      },
    ],
  },
  {
    contactKey: "luisa",
    externalSuffix: "luisa",
    conn: "waha",
    status: "resolved",
    sector: "vendas",
    assigneeRole: "agent",
    msgs: [
      {
        dir: "inbound",
        text: "O Bosun tem IA que responde sozinha? Quero algo que qualifique o lead antes de passar pro humano.",
        daysAgo: 4,
        hour: 9,
      },
      {
        dir: "outbound",
        text: "Tem sim — no Pro você configura agentes com prompt, regras de negócio e base de conhecimento. Ele sugere ou responde conforme a sua política.",
        daysAgo: 4,
        hour: 9,
        status: "read",
        authorRole: "agent",
      },
      {
        dir: "inbound",
        text: "E eu controlo quando ele fala? Não quero robô falando com cliente VIP.",
        daysAgo: 4,
        hour: 10,
      },
      {
        dir: "outbound",
        text: "Total — modo sugestão: o humano aprova cada resposta. E você limita por horário, setor e até por contato.",
        daysAgo: 4,
        hour: 10,
        status: "read",
        authorRole: "agent",
      },
      {
        dir: "inbound",
        text: "Perfeito, era o que eu precisava ouvir. Vou assinar o trial hoje!",
        daysAgo: 4,
        hour: 10,
      },
    ],
  },
  {
    contactKey: "tiago",
    externalSuffix: "tiago",
    conn: "waha",
    status: "open",
    msgs: [
      {
        dir: "inbound",
        text: "Os dados dos meus clientes ficam no Brasil? LGPD é crítico pro escritório.",
        daysAgo: 0,
        hour: 8,
      },
    ],
  },
];
