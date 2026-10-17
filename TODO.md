# TODO

Prioridades: **P0** segurança/correção urgente · **P1** próximo trabalho
planejado · **P2** quando escalar · **P3** backlog de higiene.

## Produto — backlog (fonte: docs/product/, ADR 0014)

Ordem do produto definida pelo fundador: integrações ✅ → multi-atendimento
→ chat do site → IA (observer) → leads/funil → atividades → settings.

- **P1 — Multi-atendimento**: `teams`/`team_members` (setores) ✅;
  `conversations` ganha `sector_id`, `assignee_id` e ciclo de status
  `open|in_progress|waiting_customer|resolved` ✅ (`archived` removido);
  papel `viewer` (read-only) ✅; `organization_settings` ✅ (auto-reply
  fora de horário 1×/dia ainda pendente). **Slice 2 entregue**: modelo de
  tickets — `resolved` terminal; inbound cria follow-up (`preceded_by_id`,
  sem herdar setor/assignee); `ticket_number` org + `ticket_seq` por
  contato; `resolved_at`/`first_response_at`; `messages.author_id`; views
  inbox/queue/mine/resolved ✅; ações pickup/transfer/resolve/waiting/
  in_progress ✅; `sendOutboundMessage` (provider fora da tx, gap
  send-ok/write-fail aceito v1) ✅; `addInternalNote` ✅; `resumeTicket` ✅;
  `reopenTicket` ✅ (qualquer agente; janela `ticket_reopen_window_hours`
  default 48h por org; bloqueado se follow-up ativo; `resolved_by_id` p/
  auditoria — status `closed` materializado espera camada de jobs);
  `messaging:write` (viewer negado) ✅; Server Actions
  `apps/web/src/server/actions/messaging.ts` ✅. **Slice 3 entregue**:
  inbox operável — abas Fila/Minhas/Todas/Resolvidas (`?view=`,
  server-filtered), página `/app/inbox/[id]` com timeline unificada
  (notas âmbar, eventos de sistema, divisor "Ticket anterior"),
  actions bar (Assumir/Transferir/Resolver/Aguardando/Reabrir) +
  composer Responder/Nota interna; viewer read-only; nomes via joins
  (`reads.ts`, `listOrgMembers`). **Slice 4 entregue**: `/app/settings` —
  formulário da org com `ticketReopenWindowHours` (1–168h; exposto em
  `updateOrgSettingsInput`/`upsertSettings`) + `offHoursMessage`/timezone/
  locale, edição só owner/admin — + `/app/settings/teams` (CRUD de equipes
  - membros via `listOrgMembers`, `TEAM_NAME_TAKEN`; `teams:manage`).
    **Slice 5 entregue — multi-atendimento fechado**: jobs em **pg-boss**
    in-process (ADR 0016 — Trigger.dev removido; schema `pgboss` por
    migration + grants a `crm_app`; `boss.start()` no `register()`;
    enqueue transacional no ingest via `fromDrizzle(tx)`); `closed`
    materializado pelo sweep `close-resolved-tickets` (`*/15 * * * *`,
    janela por org) com guards/views/UI atualizados (badge "Fechado" +
    botão "Novo atendimento" = follow-up de closed); auto-reply fora de
    horário 1×/conversa/dia org-local no job `process-channel-event` —
    `maybeSendOffHoursReply` com send de sistema (`authorId` null,
    `metadata.system="off_hours"`, `{proximo_atendimento}` interpolado,
    dedup via `messages_off_hours_day_idx`). Ver
    `docs/product/domain-model.md` + `rules.md`.
    **Slice 6 entregue — E1 fila operacional** (`docs/product/inbox.md`):
    workbench 3 painéis em `/app/inbox` (lista | thread | ficha do lead);
    tabs Automático/Fila/Minhas/Todas/Adiados/Fechadas com contadores
    (`listConversationViewCounts`); filtros server-side (busca, setor,
    canal — só quando >1 conexão, "aguardando resposta" = última msg
    inbound); seções Entrada→setores na Fila; seleção via `?c=`; snooze
    (`snoozed_until` + `pending` no check de status, Adiar 1h/amanhã/
    semana + Retomar, retorno lazy sem job); `[id]` redirecta pra `?c=`.
    Refs: DeskcommCRM (fila), MariaOS (painel/chat), Synthor (produto).
    Próximas etapas: E2 ficha+cadastro de contato, E3 chat power-ups
    (botão direito, macros `/`, busca no thread, toggle sendSeen),
    E4 lista "não virou negócio". **Estudo omnichannel entregue**
    (2026-10-13): `docs/product/omnichannel-research.md` — padrões de
    mercado (HelenaCRM, Sellio, Synthor, fazer.ai), falhas de produto do
    canal WAHA e diagnóstico dos bugs de mídia. Informa o escopo de
    E2/E3 e da revisão WAHA.
- **P1 — WAHA chat features (brief 2)**: implementado — ticks cinza/azul
  (`message.ack`), reações (`message_reactions` + chips/picker), edição
  com histórico (`message_edits`, janela 15min), apagado híbrido por papel
  (`revoked_at` + "ver original" p/ owner/admin/manager), presence
  typing/recording (`paused` no idle) + `presence.update` via SSE,
  áudio PTT com preview antes de enviar (`sendVoice`, `convert:true`),
  documentos/mídia (`sendFile` via upload → RustFS → URL assinada),
  `sendSeen` só ao assumir o ticket, resposta citada (`reply_to`),
  proxy autenticado `GET /api/media/[id]` p/ mídia inbound. Pesquisa em
  `docs/development/waha-setup.md`. **Nova conexão simplificada** (brief 3):
  form WAHA = só nome; creds vêm das envs da plataforma (`WAHA_BASE_URL`/
  `WAHA_API_KEY`), HMAC gerado por conexão, sessão = slug-do-nome + hex,
  criar já abre o QR (create+connect na mesma action). Pareamento real
  ✅ no staging (QR, WORKING). **Parser GOWS corrigido** (commit
  `dc43179`): a causa do `processed:0` era `media:null`/`replyTo:null`
  explícitos no payload do GOWS — `z.optional()` rejeita null, então
  todo `message` falhava o `wahaMessageSchema`. Schemas viraram
  `.nullish()`; revoked compõe id via `after`+`revokedMessageId`; quote
  compõe `{fromMe}_{chat}_{stanza}`; displayName cai no
  `_data.Info.PushName`; `fetchMedia` resolve paths relativos; chats
  `@lid` são identidade válida de ponta a ponta. `pg-boss` também foi
  corrigido (self-healing: `starting` reseta em falha + timeout 15s +
  lazy-start no enqueue, `6298f1a`). **Ingestão end-to-end ✅**
  (2026-10-06): inbound real responde `processed:1` e persiste.
  Refinamentos ficam no backlog: observar `presence.update`/acks ao
  vivo, backfill das msgs perdidas via reconcile 30min (automático),
  `channel_event` audit só se RLS, `ENV NEXT_RUNTIME=nodejs` no
  Dockerfile se quisermos instrumentation no boot standalone.
  **Revisão 2026-10-13** (`docs/product/omnichannel-research.md` §2–3):
  envio de arquivo/áudio falha em staging no `PutObject` S3 (log
  action:"chat") — bucket `bosun` existe (confirmado 2026-10-13); causa
  real ainda a observar no smoke (credenciais já conferem com RustFS);
  mídia inbound
  local no WAHA expira em 7d (S3 decidido, não aplicado — sem
  `WAHA_MEDIA_STORAGE`/`WAHA_S3_*`); trap `WAHA_S3_PROXY_FILES=False` ×
  guard SSRF do `fetchMedia`; `WAHA_APPS_ENABLED`/`WAHA_API_KEY_PLAIN`
  ausentes (app 9º dígito inativo?); `contacts.avatarUrl` nunca
  populado; sem STT de áudio inbound; envelope anti-ban incompleto;
  `sendVoice` forçar mimetype `audio/ogg; codecs=opus`.
  **Escopo aprovado 2026-10-13 — dois planos**: (1) WAHA "tudo" —
  destravar mídia staging (ops: bucket + envs), app 9º dígito
  (ops-only: `WAHA_APPS_ON` já habilita global; sem `config.apps` por
  sessão — só `WAHA_APPS_ENABLED`/`WAHA_API_KEY_PLAIN` nas envs), STT de
  áudio inbound (BYOK, `ai_transcribe_audio` default true), avatar do
  contato (RustFS + `avatarUrl`), não-lido por usuário (nova tabela
  `conversation_reads` — reverte non-goal do inbox.md), @lid outbound,
  envelope anti-ban — spec em `docs/product/channel-whatsapp.md`;
  **plano 1 implementado 2026-10-13** (migration 0030, cursor por
  usuário + mark-on-send, job `contact-avatar` + rota proxy
  `/api/contacts/[id]/avatar`, job `transcribe-audio` BYOK + toggle em
  settings/ai, envelope anti-ban em sends automatizados + sendSeen no
  send humano, @lid outbound verificado verbatim) — `/review` aprovado
  (2 fixes: `aiTranscribeAudio` na assinatura de `upsertSettings`,
  `conversationId` no evento `message.updated` do STT); **falta só a
  parte ops** ✅ (envs WAHA aplicadas via REST Coolify + restart
  healthy; bucket `bosun` confirmado existente) — resta só o smoke com
  device pareado; mark-on-open/badge ficam pro plano 2;
  (2) UI de atendimento — proposta **aprovada em entrevista**
  (2026-10-13) em `docs/product/inbox-ui-review.md`: todos os itens
  aceitos; B3 refinado (macros por org, agente propõe → aprovação de
  manager/admin/owner via staging `agent_suggestions`); B9 virou corte
  total (TeachAiDialog sai do thread — aprendizado é do observer);
  SLA/CSAT/broadcast/round-robin/prioridade = pós-v1. Ordem proposta:
  plano 1 WAHA → plano 2 superfície UI que pendura no WAHA (A1–A4,
  B4–B6, B9, C2, C3/C4, D3) → plano 3 E2/E3 revisado (C1, B1, B2, B3,
  B7, B8). `inbox.md` ainda não revisado — acontece na spec dos planos.
  **plano 2 implementado 2026-10-13** (badge não-lido + mark-on-open
  client, avatar/aguardando/ícone mídia na row, resendFailedMessage com
  claim atômico + media re-assinada, player 1/1.5/2× + transcript,
  sendSeen respeitando users.sendSeen + status, atalhos a/r/s, aside
  xl+/drawer + histórico contato + valor deal inline, TeachAiDialog
  removido) — verify:full ✅ (278 int/17 e2e) — `/review` aprovado
  (1 required: parseValueCents 100x com ponto-decimal → grupos de
  milhar sem regex); **refine pós-review (2026-10-13)**: sendSeen virou
  sinal de leitura puro — sai do send/resend humano e passa a disparar em
  `markConversationRead` (assignee ou conversa sem dono, última msg
  inbound, pref on; marker re-dispara quando inbound chega com a thread
  aberta); sticker (image/webp) renderiza sem chrome + pseudo-kind
  "sticker" na row; media inbound sem source recebe flag
  `metadata.unsupportedMedia` → nota interna no bubble — **auto-reply
  por-org entregue 2026-10-14**: `organization_settings.
unsupported_media_message` (template editável, vazio = off), envio de
  sistema 1×/ticket via `maybeSendUnsupportedMediaReply` no job
  `process-channel-event` (marker `metadata.system="unsupported_media"`,
  índice único parcial `messages_unsupported_media_idx`), textarea em
  `/app/settings/service/hours`; sem IA — texto enlatado.
  **Fixes pós-review (2026-10-15)**: retry pós-falha atualiza `content`
  da marker com o template corrente (offhours + unsupported-media);
  precedência por inbound — se o off-hours respondeu, a de mídia não
  sai (1 bolha de sistema); `vitest.unit.shared.ts` + stub
  `vitest.config.ts` por pacote levam `isolate:false`/`fsModuleCache`
  pro `turbo run test` do CI também. **mergeado 2026-10-15** — PR #47
  squash na main;
  **mergeado 2026-10-13** — PR #38 squash `366120e` na main (checks
  quality/scan/integration verdes);
  **plano 3 implementado 2026-10-14** (C1/B1/B2/B3 do inbox-ui-review):
  migration `0031` (`macros` + `contact_labels`, FORCE RLS + grants),
  módulo `macros` com CRUD manager+ e leitura geral, proposta de agente
  via `agent_suggestions` (`targetType:'macro'` fora do enum config-class
  — review dedicado na página de macros, não no Revisões de IA) com
  quatro-olhos, página `/app/settings/service/macros` + hub (zap),
  composer `/` com picker por prefixo + form de proposta inline para
  agent, ficha do contato no aside (displayName/email/phone/notes em
  `contacts.metadata` + `contact_labels`, inline-edit estilo Google
  People; etiquetas da conversa preservadas no card), busca no thread
  (`searchConversationMessages` ILIKE escapado + `listMessagesAround`
  janela ±N) com jump via `?around=<id>#msg-<id>` (ring `:target` +
  `JumpAnchor` scroll + "voltar ao final"), menu de contexto por botão
  direito (`MessageContextMenu`, display:contents event boundary, fecha
  Esc/click-outside/scroll) — verify:full ✅ (295 int/17 e2e/build) —
  `/review` ✅; plano arquivado em `tasks/plan-inbox-backend.done.md`;
  **mergeado 2026-10-14** — PR #39 squash `2bac58a` na main (checks
  quality/scan/integration verdes);
  **smoke staging 2026-10-14** (device pareado): 3 bugs corrigidos —
  (a) toda mídia inbound quebrava: WAHA monta `media.url` com o
  `WAHA_BASE_URL` _dele_ (`localhost:3000`) ≠ host interno → `fetchMedia`
  recusava; fix re-enraíza `/api/files/*` no baseUrl confiável;
  (b) microfone bloqueado por `Permissions-Policy: microphone=()` →
  `microphone=(self)`;
  (c) upload >10 MB travava "Enviando arquivo…": corpo batia nos
  defaults do Next (proxy buffer 10 MB + Server Actions 1 MB —
  `media-upload.ts` anunciava 64 MB) → ambos em `65mb` + composer/
  gravador com catch (toast + reset) e checagem de tamanho no client.
  ~~Resta `sendVoice` mimetype ogg/opus + avatarUrl~~ — ambos já
  implementados e confirmados em staging 2026-10-14 (`audio/ogg;
codecs=opus` + `convert:true`; pipeline `contact-avatar` →
  `/api/contacts/[id]/avatar`);
  **re-smoke 2026-10-14** (PR #40 deployado): arquivo >10 MB envia ✅,
  mic pede permissão ✅, **mas** (a) figurinha seguia quebrada — GOWS
  emite `media.url` = `mmg.whatsapp.net/….enc` (CDN criptografado, não
  `/api/files/`); fix = fallback `fetchMessageMedia` →
  `downloadMedia=true` no WAHA devolve `/api/files/*` local; fetch por
  URL falho agora cai no por-id e vira 404 (não 500); (b) áudio gravado
  mostrava 0:00 — blob MediaRecorder sem metadado de duração; fix =
  self-heal no `AudioPlayer` (probe currentTime) + `durationHint` com o
  elapsed medido; preview usa o mesmo `AudioPlayer` do bubble;
  **re-smoke 2 2026-10-14** (PR #41 deployado): áudio mostrava duração mas
  **não tocava** (sonda `currentTime` no próprio `<audio>` podia travar o
  elemento em seeking+muted → `play()` pendia; fix = sonda num elemento
  destacado + skip quando `durationHint`), figurinhas seguiam quebradas
  (WAHA salvou a mídia e o `downloadMedia` respondeu 200, mas sem
  `media.url` aproveitável — fetch por filename nunca acontecia; fix =
  parse `media.filename`/`media.error` → `/api/files/{filename}` +
  `logger.warn` por estágio no resolver — a falha era 404 invisível), e
  **horários saíam em UTC** (`format.dateTime` server-side no container
  UTC; fix = `LocalDateTime` client nos pontos server-rendered do inbox +
  `t.rich` com tag `<date>`). Resta: datas server-rendered fora do inbox
  (audit, contacts, members, ai) — mesmo bug sistêmico, tratar quando
  surgir; re-smoke da figurinha/áudio/horário;
  **re-smoke 3 2026-10-14** (PR #42 deployado): horários ok; **mas** —
  (a) áudio seguia sem tocar: os warns novos + repro no chrome-devtools
  revelaram `MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check`
  — o CSP do app não tinha `media-src` e caía em `default-src 'self'`,
  bloqueando **todo** `blob:` de mídia (preview do gravador e previews de
  vídeo); `img-src` já tinha `blob:` (por isso imagem funcionava). Fix:
  `media-src 'self' blob:` em `proxy.ts`;
  (b) figurinha seguia quebrada com causa exposta pelos warns: `media.url`
  vinha recusado (URL estrangeira — CDN `.enc` ou pré-assinada S3, pois
  `WAHA_MEDIA_STORAGE`/`WAHA_S3_*` estão setadas) e o fallback por
  filename 404ava porque `MediaLocalStorage` grava em
  `{session}/{messageId}.{ext}` — o path montado não tinha o diretório da
  sessão. Fix: cadeia de candidatos no `fetchMessageMedia` — url pelo
  guard → url https não-whatsapp **anônima** (S3 presign, sem a key) →
  `/api/files/{session}/{filename}` → `{session}/{bareId}.{ext}` → flat;
  **observação ops**: se o storage for S3, alternativa é
  `WAHA_S3_PROXY_FILES=True` (volta tudo para `/api/files/*` no host);
  e `WHATSAPP_FILES_LIFETIME` > ~24,8d estoura setTimeout do WAHA
  (issue #2018 — apaga o arquivo na hora → 404 eterno);
  **re-smoke 4 2026-10-14** (PR #43 deployado): áudio **tocou** ✅ (CSP
  `media-src` resolveu) mas sem waveform; figurinha seguia quebrada —
  warns confirmaram dois modos: `last: refused` (media.url da resposta
  `downloadMedia` não era `https` fetchável — provável presign `http://`
  do endpoint interno do RustFS, `isAnonymousFetchable` só aceitava
  `https:`) e `last: HTTP 404` (`filename` presente mas `/api/files/*`
  404 — `WAHA_MEDIA_STORAGE=S3` e sem `WAHA_S3_PROXY_FILES` o disco local
  não tem o objeto). Fix: fetch anônimo aceita `http:`+`https:` (só pra
  URL da resposta autenticada, `*.whatsapp.net` segue fora) + recusa loga
  o `origin` da URL (sem path/query assinado); waveform navegável no
  `AudioPlayer` (peaks via `OfflineAudioContext` em `lib/audio-peaks`,
  fill por progresso, click/drag/teclado seek, fallback de barras planas;
  gravador decodifica o blob e passa `peaks` — `fetch(blob:)` seria
  bloqueado pelo `connect-src 'self'`). Ops pendente: aplicar
  `WAHA_S3_PROXY_FILES=True` no WAHA staging (env confirmadas pelo
  usuário: `WHATSAPP_FILES_LIFETIME=604800` ✅ correto, `WAHA_MEDIA_STORAGE=S3`);
  **re-smoke 5 2026-10-14** (PR #44 deployado): waveform ✅, áudio ok —
  figurinha ainda quebrada. Access log do WAHA provou que os dois
  candidatos (`{session}/{bareId}.webp` + `/{bareId}.webp`) 404am mesmo
  com `WAHA_S3_PROXY_FILES=True` **ativo** (env confirmada via Coolify
  API): o objeto S3 é nomeado pelo **externalId serializado completo**
  (`{session}/false_<chat>_<stanza>.{ext}`) e `media.filename` traz só
  o bare stanza. Fix: candidatos serialized primeiro (flat + com
  diretório de sessão), extensão derivada do `media.mimetype` quando
  filename é null, `localhost` excluído do fetch anônimo (bateria no
  nosso próprio container);
  **re-smoke 6 2026-10-14** (PR #45 deployado): serialized-id também 404 —
  causa raiz na fonte do WAHA (`MediaS3UrlResolver.S3ProxyUrl`): com
  `WAHA_S3_PROXY_FILES=True` o `media.url` é
  `{WAHA_BASE_URL}/api/s3/{bucket}/{key}` — rota **`/api/s3/*`**, não
  `/api/files/*` (que só serve storage local). Fix: re-root de origem
  loopback e de path `/api/s3/*` no guard + candidato
  `/api/s3/{Bucket}/{Key}` do `media.s3` da resposta. Obs (não-Bosun):
  visualizar chat no WhatsApp Web do dispositivo linkado não dispara
  blue ticks pro contato — recibo nativo do WhatsApp sai só em
  interação; no Bosun o `sendSeen` ao abrir o ticket é o caminho
  equivalente;
  **re-smoke final 2026-10-14** (PR #46 deployado): mídia inbound ✅ —
  figurinha renderiza (inclusive antigas), áudio toca com waveform
  navegável, arquivo e imagem com legenda ok, mark-as-read dispara
  blue ticks (`sendSeen` ao abrir o ticket). **Decisão de storage
  (2026-10-14)**: mídia inbound fica no WAHA (`WAHA_MEDIA_STORAGE=S3`,
  `WHATSAPP_FILES_LIFETIME=604800` mantido — expira em 7d); Bosun não
  copia bytes, `/api/media/[id]` re-busca do WAHA por view. Limitação
  aceita: mídia >7d vira 404 permanente — cópia pro `tenantObjectKey`
  descartada por ora (revisitar se doer). **Débito LocalDateTime
  resolvido via infra**: `TZ=America/Sao_Paulo` nas envs do app no
  Coolify staging — datas server-rendered fora do inbox (audit/
  contacts/members/ai) saem em BRT; fix por-usuário (client-side) só
  volta a ser débito se multi-fuso virar requisito;
  **Tooling 2026-10-14**: `vitest.config.ts` com `isolate:false` +
  `fsModuleCache:true` — suite unitária local 9,7s → ~3,5s;
  **spec 2026-10-15**: `docs/product/contacts-google-sync.md` — sync de
  contatos Bosun→Google (People API), push-only contínuo, conexão por
  workspace configurada/checada via UI (BYOK, `external_connections`),
  match E.164, sobrescreve só nome, foto nunca, sem customs; futuro:
  pull bidirecional + delete→rename `Excluído`/`Bloqueado`;
- **Decisões do estudo de ADRs** (docs/adr do projeto Fluxie, somente
  referência — não-portar às cegas): `channel_event` append-only de
  payload bruto só se fizer com RLS tenant (auditoria/debug/replay);
  intake mode por canal (`open`|`pending`, default `open`) quando
  agentes de IA entrarem — inbound `pending` = em automação, agente
  entrega `open` na fila; implementar junto da UI de inbox (sem ela,
  `pending` prende tickets invisíveis).
- **Deploy — envs WAHA (Coolify)** ✅ — arquivado em `docs/todo-archive.md`.
- **P2 — Config de produto no app (env→DB criptografada)** ✅ implementado
  2026-10-06 — `platform_settings` (RLS `app.platform_scope`, AES-256-GCM via
  `encryptJson`), `resolveProductSettings`/`isProductConfigured` em
  `@crm/core/platform` (DB→env por campo), consumers rewired (sendEmail
  lazy por envio em `server/auth.ts`, Asaas service+webhook, Meta defaults
  no `createChannelConnection`), seção Plataforma em `/app/settings`
  (secrets write-only, badge "(banco)" nos campos com override) e wizard
  `/app/setup` (gate em `requireTenantContext`: `platform_admin &&
!isProductConfigured("email")`; `provider=console` salvo explicitamente
  conta como configurado). Decisão de
  design (2026-10-06). Split de envs: infra-secrets **geradas pelo
  Coolify** (`DATABASE_*`, `REDIS_*`, `STORAGE_*`, `WAHA_*`,
  `BETTER_AUTH_SECRET`, `CHANNEL_CREDENTIALS_KEY` — zero digitação) vs
  config de produto (`EMAIL_*`/Resend, chaves AI, `META_*`, `ASAAS_*`)
  que migra pra DB criptografada + settings/onboarding UI. `APP_URL`
  fica fora dos dois grupos: é **infra derivada** — o app precisa dela
  no boot (callbacks Better Auth, webhook WAHA), e o valor é sempre
  `https://` + o domínio do campo Domains do Coolify (próprio ou
  provisório). No compose self-contained sai de `SERVICE_URL_*`; no
  setup nativo é env única copiada do próprio Domains no install.
  **Pegadinha verificada**: domínio provisório sslip.io nasce `http://`
  (TLS só com `https://` no Domains ou wildcard https no server; LE
  emite p/ sslip mas é desaconselhado/rate-limited) — e o Better Auth
  marca cookie `Secure` em produção → login quebra sobre http.
  Resolver em `auth.ts`: `useSecureCookies: appUrl.startsWith("https:")`
  (deriva do APP_URL, sem env nova).
  `CHANNEL_CREDENTIALS_KEY` vira a root key das secrets em banco;
  `getServerEnv` vira cadeia `DB → env → isConfigured-noop`. Casa com o
  onboarding estilo Chatwoot e destrava sign-up sem depender de env
  Resend. **Deferidos** (conversa de 2026-10-06, reabrir quando maduro):
  compose canônico/IaC p/ VPS nova (backup nativo agendado do Coolify
  pesou a favor de manter resources nativos); auto-update em VPS nova =
  redeploy manual na UI. **Update in-app p/ self-hosted** (mesma
  conversa): settings de plataforma com check de versão (GHCR/GitHub
  releases vs `APP_VERSION` injetado no build) + botão que chama o
  deploy webhook do Coolify do próprio app (`POST /api/v1/deploy?uuid=`)
  — mesmo endpoint do cd.yml. Requer `COOLIFY_API_URL`/`APP_UUID`/
  `DEPLOY_TOKEN` (escopo deploy-only) injetados; rollback via
  healthcheck já é automático. Duas classes de instalação: mantenedor
  usa tag→webhook (hoje); self-hosted usa o botão. **Meta de
  lançamento (2026-10-13)**: no lançamento o sistema se auto-configura
  por completo na instalação; o que não der para auto-configurar termina
  no onboarding/wizard — nada de config manual espalhada.
  **Follow-up pendente** (fora do escopo do slice): form de nova conexão
  Meta em `/app/integrations` ainda exige `appSecret`/`verifyToken` no
  client — relaxar p/ "opcional — usa plataforma" quando o grupo `meta`
  estiver configurado (backend já aceita vazio e faz o merge).
  ~~**CI pendente**~~ resolvido: `ci.yml` já declara
  `CHANNEL_CREDENTIALS_KEY` de teste fixa (64 hex) no `env:` global
  (mesmo padrão do `BETTER_AUTH_SECRET`) — a entrada estava desatualizada.
- **P1 — i18n** ✅ — arquivado em `docs/todo-archive.md`.
- **P1 — Design-system lint** (`@shadcn/lint`): ✅ adotado — token rules
  em `error` nos dois pacotes UI-touching; baseline+regras em
  `docs/development/design-system-lint.md`. **Bugs corrigidos**: (a) scan
  do Tailwind não cobria `packages/ui` — classes exclusivas de internals
  geravam zero CSS (dialog descentralizado, dropdown sem min-width,
  animações mortas) — fix `@source "../"`; (b) `tw-animate-css` importado;
  (c) tokens `success`/`warning`/`info` + troca das ~23 raw colors.
  **Pendente**: `no-restyle` (contratos por componente) adiado até o DS
  assentar. **2026-10-09**: 44 warnings `no-inline-styles` zerados
  (CSS vars + classes `-(--var)`; 3 disables justificados em passthrough
  de `style` de API pública); `react`/`react-dom` movidos para
  `peerDependencies` (formato correto de lib).
- **P1 — Site chat** ✅ — arquivado em `docs/todo-archive.md`.
- **P1 — IA observer (v1)**: ✅ entregue — `org_llm_credentials` (BYOK +
  prioridade/fallback; OpenAI/Anthropic/OpenRouter — ZDR/session via
  routing OpenRouter), `ai_usage_events`, `agents`, `agent_suggestions`,
  `knowledge_entries` (RLS ×5, migration própria), permissão
  `ai:read/manage`, `@crm/core` módulos `ai`/`agents`/`knowledge`/
  `suggestions` (approve aplica payload na tx + domain events), job
  observer no pg-boss (hook no `resolveConversation` via deps injetadas +
  `observe-org` manual), `/app/settings/ai` completo (credenciais, agents,
  knowledge, inbox de sugestões, analisar agora) + toast SSE em
  `agent_suggestion.created`. Pendências: second brain (item próprio
  abaixo), triage/TTS = roadmap do spec. **Pendência nova (2026-10-13):
  seleção de modelo por credencial** — ao colar a API key, listar
  modelos do provider e deixar escolher chat/embedding/voice +
  effort/temperatura (spec em ai-agents.md → BYOK; STT hoje hardcoded
  `whisper-1`/`gemini-2.0-flash-001` vira default). ✅ AI drafts entregue — módulo
  `@crm/core/drafts` (draft = `agent_suggestions` `target_type='draft'`,
  `messaging:write`, approve = `sendOutboundMessage` fora do tx, supersede
  on regenerate, stale = inbound mais novo aprovável), `agents.kind`
  (`org`/`drafter`/`observer`, unique parcial por org), `draftReply` puro
  em `@crm/ai`, job `generate-draft` pg-boss (transcript = 40 msgs
  recentes, BYOK fallback + `ai_usage_events` `callKind='draft'`, drafter
  lazy), actions com precheck de credencial, `DraftCard` no thread +
  botões "Sugerir/Melhorar resposta" no composer + toast draft-aware no
  `inbox-live`. ✅ Observer modes (sem realtime) entregue — `ai_observer_mode`
  off/on_close/(realtime disabled na UI) + seção em settings/ai com
  interval/idle/`auto_draft`; modo `interval` roda o sweep `observer-scan`
  (cron */5, determinístico — sem LLM): ticket aberto+atribuído com última
  msg inbound e humano idle → `NudgeCard` no thread (Gerar→enqueue drafter
  /Dispensar) ou `generate-draft` direto com `auto_draft`; cleanup faz
  supersede de nudges que saíram do predicado; cooldown = idle_minutes.
  Draft e nudge dividem o slot único de card pendente por conversa
  (índice parcial IN(draft,nudge)); agent `observer` lazy com
  prompt/modelRef honrados e edição owner-only; manual "analisar agora" =
  force (bypassa o gate de modo). **Roadmap do spec**: modo realtime
  (inbound→observer decide) e migração do observer pra brain tools. Ver
  `docs/product/ai-agents.md`.
- **P1 — Second brain (memória do copiloto)**: ✅ entregue — `memory_entries`
  (RLS, FTS pt-BR, escopo org/team/contact, confidence, `stale_after`,
  `verified_by/at`, `superseded_by` cadeia temporal), staging via
  `agent_suggestions` `target_type="memory"` (proposta do observer ou de
  humano via `proposeMemoryEntry` + `proposed_by`), four-eyes com exceção
  owner, `@crm/core/brain` (canon list/search, renew/archive, sweep),
  observer lê canon+pendentes no prompt e propõe `memories[]` (sem PII,
  ≥medium, sem repropor), job `brain-stale-sweep` diário, seção Brain em
  `/app/settings/ai` + inbox renderiza memória. Design só de fontes
  externas (OKF/Google, MemGPT/Letta, Zep, mem0). `knowledge_entries`
  segue = conteúdo pro cliente; brain = aprendizado operacional interno.
  **Pendências**: `agents.brain_access`/`brain_types` no schema esperando
  runtime de agentes; digest de canon adiado (v1 lê relevantes por
  scope/FTS); embeddings/pgvector fora de escopo; feedback de rejeição no
  prompt adiado.
- **P1 — Leads/funil** ✅ — arquivado em `docs/todo-archive.md`.
- **P1 — Design system provisório** ✅ — arquivado em `docs/todo-archive.md`.
- **P1 — Design system BOSUN**: ✅ concluído (2026-10-09) — dump do
  Claude Design triado; `packages/ui` → `design-system/` (pacote `@crm/ui`
  mantido); `DESIGN.md` na raiz = contrato + fonte da verdade dos tokens
  (formato Google Labs) + `tokens.test.ts` drift test (9 asserts verdes);
  tokens de extensão + animações DS em `globals.css`; 24 componentes do DS
  com a API do dump (Radix por baixo) + dropdown/form/label/textarea
  restilizados; toast próprio sobre host Sonner (`sonner.tsx` removido,
  `next-themes` fora do pacote); vocabulário Tailwind próprio (sem nomes
  shadcn nos componentes novos); fontes Manrope/Inter/JetBrains Mono via
  `next/font`; showcase `/design-system` (dev only, temas
  escuro/claro/lado a lado); HTMLs de referência em
  `design-system/reference/` (kits com JSX inline → abrem via `file://`);
  lint de aderência portado (`tooling/eslint/design-system.js`, ver
  `docs/development/design-system-lint.md`). 2ª etapa (2026-10-09):
  todos os call sites de `apps/web` na API do DS (sem `sonner` direto,
  aliases shadcn removidos, resets `--text|radius|shadow|tracking-*`);
  6 templates (`AppTopBar`, `UserMenu`, `PageHeader`, `CommandPalette` +
  ⌘K, `EmptyState`, `AuthLayout`); shell do `/app` (Início, Atendimento,
  Negócios, Integrações, Configurações + paleta + sino + menu da conta);
  sign-in/sign-up/onboarding no layout do kit; `COMPONENTS.md`; Better
  Auth `rateLimit` só em produção (3 req/10s derrubava o e2e local);
  `getSession` com `cache()` (layout + página na mesma request);
  `design-system-export/` apagado. Ver `design-system/README.md`, ADR
  0017, `docs/product/vision.md` (conceito BOSUN). **Pendências pós-entrega**: (a) **prioridade mínima** —
  renomear o pacote `@crm/ui` → `@crm/design-system` ✅ (feito neste ciclo — pasta já era
  `design-system/`; auditabilidade, decisão do usuário); (b) migrar
  ícones `lucide-react` do app para `<Icon>` (DS tem 104 ícones; traço
  1.5 já alinhado via CSS); (c) toggle de tema / light no app real
  (tokens light prontos); (d) landing pública a partir do website kit
  (fora de escopo por decisão); (e) white-label por tenant sobre os
  tokens CSS; (f) logo oficial — hoje `Wordmark`; (g) login: "Manter
  conectado", "Esqueci minha senha" (Better Auth já tem
  `sendResetPassword`, falta a página) e SSO — omitidos do layout do kit
  por não existirem (decisão do usuário, 2026-10-09); (h) Início com
  métricas reais no formato do dashboard do kit (exige leituras novas em
  `@crm/core`); (i) feature de notificações — o sino do top bar hoje abre
  só o estado vazio; (j) `AuthLayout` usa colunas iguais (o kit usa
  1.15fr/1fr — sem token de grid para a proporção).
- **P2 — Contatos: criação manual + conversa outbound-first** ✅ — arquivado em `docs/todo-archive.md`.
- **Decisão — round-robin descartado** (2026-10-08): atribuição segue manual
  da fila; quando agentes IA entrarem, roteamento é via intake
  `open`|`pending` (pending = IA atende) — não por rodízio de agentes.
- **P1 — IA + navegação (reforma da interface)**: specs aprovadas
  2026-10-12 — `docs/product/ia-navegacao.md` (árvore, rotas, matriz de
  configurações, permissões novas, fluxos) + `layout-desktop-app.md`
  (piso 1536×740 obrigatório, família Layout de tokens, formato app
  `100dvh`). Execução em 7 slices (ordem sugerida no doc). **Slice 1
  entregue** (2026-10-12): tokens Layout (`page-pad`,
  `page-header-compact`, `inbox-list(-sm)`, `inbox-aside(-sm)`,
  `thread-measure`, `kanban-column`, `viewport-*`) no DESIGN.md +
  `spacing.css` + `@theme`; `IconButton` ganha `asChild` (Radix Slot);
  `PageHeader` com `compact` (56px, título h3, abas na linha) e `back`
  (arrow-left via `linkComponent`); template `AppShell` (grade `100dvh`,
  topBar/header fixos, rolagem independente) — tudo em `design-system/`,
  showcase + docs atualizados. Medido no Chrome: 1920×930 e 1536×740 sem
  rolagem horizontal. **Slice 2 entregue** (2026-10-12): shell por papel —
  `app/layout.tsx` passa `role`/`isPlatformAdmin`/`organizations` via
  `getTenantContext` + `listMyOrganizations`; ModuleNav perde
  Integrações/Configurações e ganha Inteligência (gate `ai:read`); engrenagem
  → `/app/settings` só com permissão de gestão; `UserMenu` com Minha conta,
  "Trocar para {org}" (`authClient.organization.setActive`) e Plataforma
  (platform_admin); ⌘K com Módulos/Configurações/Minha conta/Ações; página
  presa em `100dvh` com rolagem na região de conteúdo (scroller do
  `AppShell` virou `div` — landmark `<main>` único por página). Rotas stub:
  `/app/ai` (ai:read → 404), `/app/account` (todos), `/app/platform`
  (platform_admin → 404). Verificado no Chrome com owner e agent (menu,
  engrenagem, ⌘K, stubs e 404s). **Slice 3 entregue** (2026-10-12): hub de
  Configurações — `/app/settings` vira índice com 5 grupos filtrados pela
  matriz §7.7 (`organization:update`, `member:create`, `billing:read`,
  `audit:read`, `teams:manage`, `integrations:manage`, `leads:manage`,
  `ai:manage`); agent/viewer veem EmptyState. Rotas reais:
  `organization/general` (fuso/idioma), `service/hours` (msg fora do
  horário), `service/rules` (reabertura) — form antigo dividido;
  `service/teams` e `settings/channels` (moves com redirect 307 dos
  endereços antigos); `settings/sales/funnels` real — edição de
  funil/etapas saiu do quadro, que ganhou atalho "Editar funil"
  (`?funnel=`); stubs members/billing/audit com endereço canônico.
  Plataforma separada: `/app/platform` índice + `/app/platform/{email,
billing,meta,ai}` (platform_admin; link para `/app/setup`). Refs
  atualizadas: checklist do Início, ⌘K (destinos + permissões por item),
  `live-refresh`, `revalidatePath` das actions. `canManage` de Canais
  corrigido p/ `integrations:manage` (era `role !== "agent"` — incluía
  viewer). Verificado no Chrome com agent/manager/owner/superadmin +
  1536×740. **Slice 4 entregue** (2026-10-12): Atendimento — 4 abas com
  contador (Fila/Minhas/Adiados/Fechadas) + filtro "Ver" em pílula ao lado
  da busca (Automático=`?view=pending`, Todas=`?view=all`); larguras por
  token `inbox-list(-sm)`/`inbox-aside(-sm)` com novo breakpoint
  `wide:` (106.25rem — o limiar HIP, declarado em rem para ordenar com os
  breakpoints padrão do Tailwind); vocabulário Rascunho/Aviso na conversa;
  e2e `inbox.spec.ts` atualizado. Verificado no Chrome: 360px@1920,
  320px@1536, sem scroll horizontal, deep links `/app/inbox/<id>`→`?c=`
  e `?view=pending|all` sem aba ativa. **Slice 5 entregue**
  (2026-10-12): Inteligência — módulo `/app/ai` com faixa Resumo
  (credencial, modo do observador, última análise, pendências) e 3 tabs
  (Revisões = fila de propostas + "Analisar agora"; Conhecimento; Memória);
  settings técnico reduzido a Agentes + Credenciais com detalhe
  `/settings/ai/agents/[id]` em 4 seções e página híbrida `observer`;
  redirects 307 dos endereços antigos (suggestions→reviews, brain→memory,
  knowledge→knowledge, observer→agents/observer, index→agents); **"Ensinar
  a IA"** na conversa (messaging:write → conhecimento; memória restrita a
  owner/admin — gate no service `proposeMemoryEntry` + `proposeKnowledgeEntry`
  novos em `@crm/core`); campos do form de agente extraídos p/
  `agent-fields.tsx` (reuso lista+detalhe); e2e `ai.spec.ts`. Verificado no
  Chrome (owner): redirects, tabs, detalhe salvar/excluir, proposta caindo
  em Revisões, console limpo. **Slice 6 entregue** (2026-10-12): Início
  "Hoje" — `/app` vira superfície operacional (Esperando por você =
  fila/minhas; Inteligência = revisões+memórias vencidas, ai:manage;
  Precisa de atenção = conexões error/disconnected,
  integrations:manage; checklist só se incompleto) — card conta e
  auditoria crua removidos; auditoria real em
  `/app/settings/organization/audit` (gate audit:read, 50 eventos);
  **sino real**: `loadShellAlerts` deriva itens de dados existentes
  (revisões+memórias ai:manage, conexões integrations:manage,
  transferências privadas `metadata.system='transfer'` p/ o usuário,
  `listMyTransfers` em `messaging/reads-transfers.ts`, 5/14d só tickets
  ativos) — `dot` no IconButton + itens c/ ícone+href + empty state;
  live-refresh: /app home refresca em conversation./agent_suggestion./
  connection., demais /app só nos eventos raros do sino (perf);
  `home.spec.ts` novo (owner+agent), auth-flow.spec aponta auditoria.
  Verificado Chrome: owner (cards+dot+item), agent (só Esperando+
  checklist, empty), auditoria real, 1536×740 sem scroll. **Slice 7
  entregue** (2026-10-13): telas PARCIAL/NOVO — **Minha conta**
  `/app/account` com 4 tabs: Perfil (nome via `auth.api.updateUser` +
  foto real: `POST /api/avatar` user-scoped `userAvatarKey`, serve
  `/api/avatar/[userId]` gate self-ou-mesma-org), Segurança (troca de
  senha com `revokeOtherSessions` + listar/revogar sessões),
  Preferências (tema claro/escuro real — cookie `bosun-theme` lido no
  root layout p/ `data-theme` SSR; `sendSeen` persistida, consumer no
  canal fica p/ E3), Notificações (3 toggles que gateiam os toasts do
  InboxLive — drafts/nudges/suggestions, primitive deps p/ não
  reinscrever SSE). `users.preferences` jsonb (migration 0028, módulo
  `@crm/core/users`, zod merge-on-write, self-scope). **Membros**
  (`/app/settings/organization/members`, gate `member:create OR
invitation:create`): lista + convites pendentes com **link copiável
  sempre exibido** (`sendInvitationEmail` wired best-effort no plugin),
  dialog com papel capado no rank do ator + equipe opcional (`team_id`
  novo em `organization_invitations`), mudar papel / remover (owner
  protegido, sem self). **Aceite**: `/accept-invitation/[id]` público
  (id=capability), `?next=` com guard open-redirect em sign-in/sign-up
  (`safeNext`: `/` sem `//`), e-mail da sessão precisa bater com o
  convite, `assignTeamMember` no aceite + `setActiveOrganization`.
  **Horário** (`/app/settings/service/hours`): editor semanal 7 dias ×
  toggle + até 2 janelas, `offHoursMessage`, timezone readonly→Geral,
  parse via `businessHoursSchema`. e2e: `account.spec.ts` +
  `members.spec.ts` novos (convite→aceite→org num contexto — SSE do
  InboxLive travava `browserContext.close`), `settings.spec.ts` cobre
  horário. Verificado Chrome: upload de foto (200 + render), tema claro
  persistido após reload, fluxo inteiro do convite (owner cria → link →
  sign-up `?next` → aceite → agente na org + listado), e-mail errado
  bloqueado, Segunda 09:00–18:00 persiste, shell fixo 100dvh.
  **Ciclo de navegação completo** — todos os itens de `ia-navegacao.md`
  §8 saem de stub/PARCIAL.
- **P2 — Atividades/tasks** em contatos/deals/conversas.
- **P2 — Settings**: branding (logo/tema, `custom_domain` reservado),
  plano/billing UI, `usage_counters` (storage, 500 MB
  free → por GB).
- **P2 — Canais seguintes**: Instagram/Facebook (Meta), e-mail (decidir
  provedor inbound), Telegram.
- **P2 — Google**: slice 1/3 **conexão por workspace** ✅ 2026-10-15
  (`external_connections` + OAuth BYOK + card em `/app/settings/channels`;
  PR #48 mergeado; OAuth real validado no staging em 2026-10-16: conexão com o
  Google concluída, com o aviso esperado de "app não verificado" do modo
  Testing — a verificação do app fica para o fim do desenvolvimento). Slice 2/3 **perfil do
  contato** ✅ 2026-10-15 (empresa, cargo, endereço, aniversário, sites além
  de e-mail/telefone/notas; ficha do inbox + dialog "Editar" em
  `/app/contacts`; PR #49 mergeado). Slice 3a **motor de sync manual** ✅
  2026-10-16 (job `contact-google-sync` em fila `key_strict_fifo` por org +
  botão "Sincronizar agora"; falta o teste manual no staging com o Google
  real). **Slice 3b** (próxima): gatilho automático nas edições, varredura
  periódica, `batchCreate/UpdateContacts`, resumo do card em uma consulta
  SQL, contador/faixa de falhas, enfileirar em job único (hoje sequencial
  na requisição), `metadata.google` fora do navegador (passar só as chaves
  do perfil), cliente People em cache no handler. Spec em
  `docs/product/contacts-google-sync.md`. Depois: Calendar, Gmail tools. Em
  aberto: toast de retorno do Google duplicado no dev (checar em build de
  produção). **Antes/dentro da slice 3** (achados do review pré-ship da
  slice 2): rejeitar caracteres de controle/bidi em `company`, `jobTitle`
  e `address` e credenciais embutidas em `urls` (`https://user:pass@…`)
  antes de espelhar no Google; decidir se endereço e aniversário (dados
  pessoais, LGPD) são espelhados por padrão ou por opt-in da organização;
  se `urls` virarem links, usar `rel="noopener noreferrer"`; teste e2e de
  que `viewer` não vê o botão "Editar" (precisa de um usuário viewer no
  seed do e2e); passar ao dialog só as chaves do perfil, não todo o
  `metadata`.
- **P3 — LGPD endpoints**: exportar/excluir dados do contato, retenção.

## Implementação futura (prioridade)

- **P2 — Tradução global de erros pg no `withTenant`**: hoje
  `translatePgErrors` (`@crm/core` `lib/pg-error.ts`) é opt-in por chamada;
  mover a tradução pro `@crm/db` faria todo caller receber `PgError` tipado
  sem wrapper. Esperar o opt-in provar demanda — avaliar blast radius nos
  catchs existentes.
- **P2 — Rate limit em Redis** quando houver >1 instância do web. Benefício:
  limites corretos multi-instância. Custo: baixo.
- **P2 — Sentry sourcemaps/upload wiring**. Benefício: stacks legíveis em
  produção. Custo: baixo.
- **P2 — Branch protection na `main`**: exige GitHub Pro em repo privado
  (API retornou 403). Quando o plano subir: required checks
  `quality`/`integration`/`scan` + bloquear force-push. Ver
  `docs/development/cicd.md`.
- **P2 — Perf: crescimento dos reads quentes** ✅ — arquivado em `docs/todo-archive.md`.
- **P3 — Upgrade Coolify** ≥4.4: traz API de registries
  (`POST /servers/{uuid}/registries`) — docker login vira automável via
  API/MCP. Manutenção planejada, afeta outros projetos no servidor.

## Pesquisa / upgrades futuros

- **Gatilho — `.coolify-secrets.tmp`**: decisão 2026-10-13 mantém o arquivo
  como referência local de secrets (gitignored + fora do build context)
  enquanto o produto não tem usuários. Ao primeiro usuário/dado real em
  produção: migrar tudo para o cofre/painel e excluir o arquivo.
- **P1 — Node 26**: migrar após 2026-10-28 (vira LTS) + validação da toolchain.
- **P1 — TypeScript 7**: migrar quando typescript-eslint suportar (acompanhar
  typescript-eslint#10940; API só chega no TS 7.1). `tsgo` como typecheck
  sidecar é opção intermediária.
- **P3 — `erasableSyntaxOnly`**: revertido na adoção (7 propriedades de
  parâmetro de construtor em 7 arquivos > teto de 3). A expansão é mecânica;
  refazer o trial depois libera compat com type-stripping/tsgo. Ver
  docs/adr/0013.
- **P3 — Split lint tipado/não-tipado** se lint passar de ~30s (hoje ~25s
  uncached). Ver docs/adr/0013.
- **P3 — Dead-code sweep (knip), dependabot/renovate, git hooks** para
  contribuidores humanos.
- **P3 — Logger edge-safe**: `instrumentation.ts` puxa
  `@crm/observability` para o bundle Edge e o Turbopack avisa que
  `process.stdout/stderr` não existem lá (warning de build, não erro).
  Opções: isolar o registro de streams atrás de uma checagem de runtime ou
  variant `edge` do logger.
- **P3 — GitHub MCP instável**: `github-mcp-server` responde reads
  (`get_me` ok) mas falha conexão em writes (`create_pull_request` —
  PRs #1 e #2 foram criadas via `gh` fallback). Diagnosticar se é
  transporte/sessão do MCP local. Regra atual: MCP primeiro, `gh` CLI como
  fallback em operações de pull request após a primeira falha (AGENTS.md).
- **P3 — Promover warns a error** — o orçamento de warns agora vive em
  `docs/development/code-quality-standard.md` §2.3 (contagem medida por
  regra, 2026-10-10; promoção quando a contagem zerar). Nota: o branch
  `chore/lint-warnings` citado aqui antes não mergeou — as contagens
  atuais ainda mostram violações (`max-statements` 68,
  `no-unnecessary-condition` 4, `prefer-nullish-coalescing` 1);
  `complexity` está zerado e já virou `error` na config.

- **P2 — Zerar os warnings de lint (componentes, tamanho, função)** —
  decidido 2026-10-15: assim que o ship de `feat/google-contacts-connection`
  (slice 1/3 do Google Contacts) fechar, abrir um plan dedicado
  (`/plan` com `## Escopo` por pacote) para resolver os avisos de
  `max-lines`, `max-lines-per-function`, `max-params`, `max-statements`,
  regras de componente e afins. Medição de 2026-10-15 (warnings por
  pacote): core 121, web 147, design-system 38, auth 15, storage 8,
  config 4, db 2, ai 1. Fatiar por pacote/regra (≈100 linhas por commit),
  sem misturar com feature, e só depois promover a `error`
  (ver item acima).

## Concluído

Movido para `docs/changelog.md` (AUD-024) — o histórico de entregas vive
lá; `tasks/briefs/` e `tasks/*.done.md` seguem como arquivo local por
tarefa. Links e referências preservados no arquivo novo.
