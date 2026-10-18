"use client";

import * as React from "react";

import { Avatar } from "../components/avatar";
import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import { IconButton } from "../components/icon-button";
import { Input } from "../components/input";
import { ModuleNav } from "../components/module-nav";
import { Radio } from "../components/radio";
import { Select } from "../components/select";
import { Switch } from "../components/switch";
import { Tabs } from "../components/tabs";
import { Tag } from "../components/tag";
import { Textarea } from "../components/textarea";
import { Labeled, Row, Section } from "./helpers";

const MODULES = [
  { id: "inicio", label: "Início", icon: "house" as const },
  { id: "atendimento", label: "Atendimento", icon: "inbox" as const, badge: 3 },
  { id: "negocios", label: "Negócios", icon: "folder-kanban" as const },
  { id: "integracoes", label: "Integrações", icon: "plug" as const },
  { id: "config", label: "Configurações", icon: "settings" as const },
];

function ButtonStates() {
  return (
    <>
      <Row>
        <Labeled label="default">
          <Button>Estados</Button>
        </Labeled>
        <Labeled label="hover">
          <Button data-preview="hover">Estados</Button>
        </Labeled>
        <Labeled label="active">
          <Button data-preview="active">Estados</Button>
        </Labeled>
        <Labeled label="focus">
          <Button data-preview="focus">Estados</Button>
        </Labeled>
        <Labeled label="disabled">
          <Button disabled>Estados</Button>
        </Labeled>
        <Labeled label="loading">
          <Button loading>Estados</Button>
        </Labeled>
      </Row>
      <Row>
        <Labeled label="primary hover">
          <Button variant="primary" data-preview="hover">
            Estados
          </Button>
        </Labeled>
        <Labeled label="primary focus">
          <Button variant="primary" data-preview="focus">
            Estados
          </Button>
        </Labeled>
        <Labeled label="danger hover">
          <Button variant="danger" data-preview="hover">
            Estados
          </Button>
        </Labeled>
      </Row>
    </>
  );
}

function ButtonSection() {
  return (
    <Section title="Button">
      <Row>
        <Button variant="primary">Nova conversa</Button>
        <Button>Salvar alterações</Button>
        <Button variant="outline">Ver detalhes</Button>
        <Button variant="ghost">Cancelar</Button>
        <Button variant="inverse">Exportar</Button>
        <Button variant="danger">Excluir fluxo</Button>
      </Row>
      <Row>
        <Button size="sm" iconLeft="plus">
          Compacto
        </Button>
        <Button size="lg" variant="primary" iconRight="arrow-right">
          Começar agora
        </Button>
        <Button loading>Enviando</Button>
        <Button disabled>Indisponível</Button>
      </Row>
      <ButtonStates />
    </Section>
  );
}

function IconButtonSection() {
  return (
    <Section title="IconButton">
      <Row>
        <IconButton icon="bell" label="Notificações" />
        <IconButton icon="search" label="Buscar" variant="inverse" />
        <IconButton icon="plus" label="Novo" variant="accent" />
        <IconButton icon="sliders-horizontal" label="Filtros" variant="outline" />
        <IconButton icon="ellipsis" label="Mais" variant="ghost" />
        <IconButton icon="bell" label="Notificações" dot />
        <IconButton icon="x" label="Fechar" size="sm" />
        <IconButton icon="check" label="Confirmar" size="lg" variant="accent" />
        <IconButton icon="bell" label="Desativado" disabled />
      </Row>
      <span className="bg-signal inline-flex w-fit rounded-lg p-3">
        <IconButton icon="arrow-up-right" label="Abrir" variant="onAccent" />
      </span>
    </Section>
  );
}

function BadgeTagSection() {
  return (
    <Section title="Badge & Tag">
      <Row>
        <Badge>Neutro</Badge>
        <Badge tone="accent">Em destaque</Badge>
        <Badge tone="success" icon="arrow-up-right">
          18% esta semana
        </Badge>
        <Badge tone="warning">Atenção</Badge>
        <Badge tone="danger">Falhou</Badge>
        <Badge tone="info">Novo</Badge>
        <Badge tone="running" dot>
          Executando
        </Badge>
      </Row>
      <Row>
        <Badge variant="solid" tone="accent">
          Sólido
        </Badge>
        <Badge variant="solid" tone="success">
          Concluído
        </Badge>
        <Badge variant="solid" tone="danger">
          Erro
        </Badge>
        <Badge size="sm" tone="info">
          Pequeno
        </Badge>
      </Row>
      <Row>
        <Tag>Etiqueta</Tag>
        <Tag icon="list-checks">Triagem</Tag>
        <Tag selected>Selecionada</Tag>
        <Tag onRemove={() => undefined} icon="sparkles">
          Removível
        </Tag>
        <Tag onClick={() => undefined}>Clicável</Tag>
        <Tag size="sm">Compacta</Tag>
      </Row>
    </Section>
  );
}

function InputsDemo() {
  return (
    <>
      <Input label="Buscar" icon="search" placeholder="Buscar conversas, contatos…" />
      <Input
        label="E-mail"
        shape="rounded"
        placeholder="voce@empresa.com"
        hint="Usado para notificações da conta."
      />
      <Input
        label="E-mail"
        shape="rounded"
        error="Formato de e-mail inválido."
        defaultValue="nao-e-email"
      />
      <Row>
        <Input size="sm" placeholder="Compacto" className="flex-1" />
        <Input size="lg" icon="search" placeholder="Grande" className="flex-1" />
        <Input placeholder="Desativado" disabled className="flex-1" />
      </Row>
      <Textarea placeholder="Escreva uma resposta…" aria-label="Resposta" />
    </>
  );
}

function SelectsDemo() {
  const [selectVal, setSelectVal] = React.useState("Triagem");
  return (
    <>
      <Row>
        <Select
          label="Fila"
          icon="list-checks"
          options={["Triagem", "Em andamento", "Resolvido"]}
          value={selectVal}
          onChange={setSelectVal}
        />
        <Select
          options={[
            { value: "7d", label: "Últimos 7 dias" },
            { value: "30d", label: "Últimos 30 dias" },
            { value: "90d", label: "Últimos 90 dias", disabled: true },
          ]}
          placeholder="Período"
          size="sm"
        />
        <Select options={["A", "B"]} error="Escolha inválida." />
      </Row>
    </>
  );
}

function ChoicesDemo() {
  const [checked, setChecked] = React.useState(true);
  const [radio, setRadio] = React.useState("email");
  const [sw, setSw] = React.useState(true);
  return (
    <>
      <Row>
        <Checkbox
          checked={checked}
          onChange={setChecked}
          label="Notificar por e-mail"
          description="Você recebe um resumo diário."
        />
        <Checkbox label="Pendente" />
        <Checkbox indeterminate label="Parcial" />
        <Checkbox disabled label="Desativado" />
      </Row>
      <Radio
        name="Canal"
        value={radio}
        onChange={setRadio}
        options={[
          { value: "email", label: "E-mail", description: "Resposta em até 1 dia útil." },
          { value: "chat", label: "Chat", description: "Resposta em minutos." },
          { value: "phone", label: "Telefone" },
        ]}
      />
      <Row>
        <Switch
          checked={sw}
          onChange={setSw}
          label="Automação ativa"
          description="Executa quando uma conversa é resolvida."
        />
        <Switch size="sm" label="Compacto" />
        <Switch disabled label="Desativado" />
      </Row>
    </>
  );
}

function FormulariosSection() {
  return (
    <Section title="Formulários">
      <div className="max-w-text grid grid-cols-1 gap-5">
        <InputsDemo />
        <SelectsDemo />
        <ChoicesDemo />
      </div>
    </Section>
  );
}

function NavegacaoSection() {
  const [tab, setTab] = React.useState("ativos");
  const [nav, setNav] = React.useState("inicio");
  return (
    <Section title="Navegação">
      <ModuleNav items={MODULES} value={nav} onChange={setNav} />
      <ModuleNav items={MODULES} compact value={nav} onChange={setNav} />
      <Tabs
        items={[
          { value: "ativos", label: "Ativos", count: 12 },
          { value: "pausados", label: "Pausados", count: 3 },
          { value: "arquivados", label: "Arquivados" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <Tabs variant="pill" items={["Dia", "Semana", "Mês"]} defaultValue="Semana" />
    </Section>
  );
}

export function ComponentesA() {
  return (
    <>
      <ButtonSection />
      <IconButtonSection />
      <BadgeTagSection />
      <Section title="Avatar">
        <Row>
          <Avatar name="Ana Prado" size="xs" />
          <Avatar name="Ana Prado" size="sm" />
          <Avatar name="Ana Prado" size="md" />
          <Avatar name="Ana Prado" size="lg" status="online" />
          <Avatar name="Ana Prado" size="xl" ring />
          <Avatar name="Bruno Silva" size="md" status="busy" />
          <Avatar name="Carla Nunes" size="md" status="offline" />
        </Row>
      </Section>
      <FormulariosSection />
      <NavegacaoSection />
    </>
  );
}
