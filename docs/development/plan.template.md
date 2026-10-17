# Plan — <nome do item>

- **Origem**: `TODO.md` → <item> · `docs/product/<doc>.md`
- **Lifecycle**: spec → plan → build → test → review → ship
- **Data**:

## Objetivo

<uma frase — o que esta entrega faz existir>

## Contexto

<decisões tomadas no gate de esclarecimento — o porquê, não só o quê;
provisórias ficam marcadas como tal>

## Fontes consultadas

<!-- Regra "docs antes de código": decisão sobre biblioteca/API externa se
     apoia em documentação atual da versão em uso (Context7 para libs, docs
     oficiais para APIs de provedores, tipos instalados como fallback).
     Dúvida nova durante o build entra aqui ANTES do código. -->

| Tema | Versão / alvo | Fonte | Data | O que confirmou |
| ---- | ------------- | ----- | ---- | --------------- |

## Escopo

<!-- Globs relativos à raiz. O hook bloqueia edições fora daqui.
     Inclua os testes e a pasta do pacote/rota — docs e .md são sempre livres. -->

packages/core/src/modules/<modulo>/**
apps/web/src/app/app/<rota>/**

## Fora de escopo

<o que NÃO tocar mesmo parecendo relacionado — fica para outro plan>

## Tarefas

<slices finos ordenados por dependência — espelhados em tasks/todo.md
com acceptance + verify por task>

## Critérios de pronto

- [ ] `pnpm verify` verde
- [ ] Testes alvo: <quais — ex.: `*.int.test.ts` do módulo>
- [ ] Docs atualizadas: <quais>
- [ ] `TODO.md` movido para Concluído
