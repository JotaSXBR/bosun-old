# Todo — Google Contacts: motor de sync (3a)

Plano: `tasks/plan.md`.

## Task 1: Endurecer o perfil do contato

- [x] `updateContactProfileInput` e `createContactInput` rejeitam caracteres de
      controle (exceto `\n` em `address`/`notes`) e marcas bidi em
      `displayName`, `company`, `jobTitle`, `address`, `notes`
- [x] `urls` rejeita credenciais embutidas (`https://user:pass@host`)
- [x] Testes unitários (`schemas.test.ts`) e de integração (nada é gravado)
- **Acceptance**: valores com NUL, `\r` ou bidi são recusados; `https://acme.test`
  continua válido; `https://u:p@acme.test` é recusado
- **Verify**: `pnpm --filter @crm/core test` · integração dos contatos
- **Deps**: nenhuma · **Tamanho**: S

## Task 2: Cliente da People API

- [x] Interface `GooglePeopleClient`: `searchByPhoneOrEmail` (com aquecimento
      único), `createContact`, `getContact`, `updateContact` (etag +
      `updatePersonFields`)
- [x] Backoff em 429/5xx (injeção de `sleep` para teste), erros tipados
      (`failedPrecondition`, `unauthorized`, `rate_limited`)
- [x] `getValidAccessToken(db, ctx)` no serviço: renova o token expirado,
      persiste, `invalid_grant` → `needs_reauth`
- [x] Fake para testes; testes com `fetch` falso
- **Acceptance**: URLs/parâmetros batem com a doc; 429 repete com backoff e
  desiste após N; 400 `failedPrecondition` vira erro tipado; token expirado é
  renovado antes da chamada
- **Verify**: `pnpm --filter @crm/core test` · integração do serviço
- **Deps**: nenhuma · **Tamanho**: M

## Task 3: Mapeamento Bosun → Person

- [x] `toPerson(contact)` puro: `names`, `phoneNumbers` (canal + `phone`),
      `emailAddresses`, `organizations`, `addresses`, `biographies`,
      `birthdays`, `urls`
- [x] `isEligible(contact)` e `payloadHash(person)` (sha256 do JSON canônico)
- **Acceptance**: no máximo um valor em `names`/`birthdays`/`biographies`;
  sem telefone `@c.us` nem e-mail → inelegível; nome ausente → sem `names`;
  mesmo contato → mesmo hash; campo alterado → hash diferente
- **Verify**: `pnpm --filter @crm/core test`
- **Deps**: nenhuma · **Tamanho**: M

### Checkpoint: após as tarefas 1–3

- [x] `pnpm verify` verde · revisar com o humano

## Task 4: Job `contact-google-sync`

- [x] `contactGoogleSyncHandler({ organizationId, contactId })`: conexão
      `connected`, token válido, `resourceName` conhecido ou busca com igualdade
      exata, create/update com etag (uma releitura), pula se o hash não mudou
- [x] Grava `metadata.google` (`resourceName`, `etag`, `payloadHash`,
      `lastSyncedAt`) sem alterar `updated_at`
- [x] Fila criada em `boss.ts` com `policy: 'key_strict_fifo'` + `enqueueContactGoogleSync`
      sempre com `singletonKey: google:<organizationId>`; erro de um contato
      grava `lastError` e conclui o job (nunca deixa `failed`)
- [x] Teste de integração com o cliente falso (criar, atualizar, sem mudança,
      conflito de etag, token revogado, sem conexão = no-op)
- **Acceptance**: sem conexão `connected` nada é chamado; repetir o job não
  duplica nem chama o Google; `invalid_grant` marca `needs_reauth`
- **Verify**: integração do job · `pnpm verify`
- **Deps**: 2, 3 · **Tamanho**: M

### Checkpoint: após a tarefa 4

- [ ] `pnpm verify` e integração verdes · revisar com o humano

## Task 5: Botão "Sincronizar agora" no card

- [x] Action `syncGoogleContactsAction` (manage) enfileira um job por contato
      elegível, em páginas
- [x] Card mostra elegíveis / sincronizados / última sincronização e o botão
- [x] Textos pt-BR; só `integrations:manage` vê o botão
- **Acceptance**: o clique enfileira N jobs e o card atualiza; sem conexão o
  botão não aparece; viewer não vê o botão
- **Verify**: `pnpm verify` · integração da action · teste manual no staging
- **Deps**: 4 · **Tamanho**: M

### Checkpoint: final

- [ ] `pnpm verify:full` verde · teste manual no staging com o Google real ·
      critérios de pronto marcados · review e ship
