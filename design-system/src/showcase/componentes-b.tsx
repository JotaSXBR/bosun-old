"use client";

import * as React from "react";

import { Accordion } from "../components/accordion";
import { BarChart } from "../components/bar-chart";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { Dialog } from "../components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import { IconButton } from "../components/icon-button";
import { Metric } from "../components/metric";
import { ProgressBar } from "../components/progress-bar";
import { RingChart } from "../components/ring-chart";
import { Steps } from "../components/steps";
import { Toast, toast } from "../components/toast";
import { Tooltip, TooltipBubble } from "../components/tooltip";
import { Row, Section } from "./helpers";
import { Templates } from "./templates";

function DialogSection() {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  return (
    <Section title="Dialog">
      <Button onClick={() => setDialogOpen(true)}>Abrir diálogo</Button>
      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="Revogar acesso"
        description="A integração deixa de receber eventos na hora. Você pode reconectar depois."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={() => setDialogOpen(false)}>
              Revogar acesso
            </Button>
          </>
        }
      >
        <p className="text-ink text-sm">
          Webhooks pendentes são descartados e o histórico é mantido.
        </p>
      </Dialog>
    </Section>
  );
}

function DadosSection() {
  return (
    <Section title="Dados">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <ProgressBar
          value={68}
          label="Meta da semana"
          valueLabel="68%"
          labels={["seg", "ter", "qua", "qui", "sex"]}
        />
        <ProgressBar value={34} tone="warning" thumb label="Capacidade" valueLabel="34%" />
        <Card
          title="Execuções hoje"
          actions={
            <>
              <IconButton icon="bell" label="Alertas" />
              <IconButton icon="arrow-up-right" label="Detalhes" />
            </>
          }
        >
          <div className="flex items-center justify-between gap-3 pt-2">
            <ul className="text-ui flex flex-col gap-2.5">
              {[
                ["bg-data-1", "Automáticas", "70%"],
                ["bg-data-2", "Manuais", "30%"],
              ].map(([dot, name, pct]) => (
                <li key={name} className="flex items-center gap-2">
                  <span className={`size-2 rounded-full ${dot}`} aria-hidden />
                  {name}
                  <span className="text-ink-muted">{pct}</span>
                </li>
              ))}
            </ul>
            <RingChart
              size={132}
              thickness={18}
              segments={[
                { value: 70, color: "var(--data-1)" },
                { value: 30, color: "var(--data-2)" },
              ]}
            />
          </div>
        </Card>
        <Card title="Carga da equipe">
          <div className="flex items-center gap-5">
            <RingChart
              size={104}
              thickness={14}
              showValues={false}
              segments={[
                { value: 3, color: "var(--data-1)" },
                { value: 2, color: "var(--data-2)" },
                { value: 2, color: "var(--data-3)" },
              ]}
            />
            <ul className="text-ui flex flex-col gap-2.5">
              {[
                ["Marina Costa", 3, "bg-data-1"],
                ["Rafael Lima", 2, "bg-data-2"],
                ["Ana Dias", 2, "bg-data-3"],
              ].map(([name, count, dot]) => (
                <li key={name} className="flex items-center gap-2">
                  <span className={`size-2 rounded-full ${dot}`} aria-hidden />
                  {name}
                  <span className="text-ink-muted">{count}</span>
                </li>
              ))}
            </ul>
          </div>
        </Card>
        <BarChart
          data={[
            { label: "Seg", value: 42, target: 60 },
            { label: "Ter", value: 55, target: 60 },
            { label: "Qua", value: 38, target: 60 },
            { label: "Qui", value: 71, target: 60 },
            { label: "Sex", value: 64, target: 60 },
          ]}
          formatValue={(v) => `${v} conversas`}
        />
      </div>
    </Section>
  );
}

export function ComponentesB() {
  return (
    <>
      <DadosSection />

      <Section title="Card">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card
            title="Conversas abertas"
            subtitle="Atualizado há 2 minutos"
            actions={
              <>
                <IconButton size="sm" icon="arrow-up-right" label="Abrir" />
                <IconButton size="sm" icon="ellipsis" label="Opções" />
              </>
            }
          >
            <Metric value="1.284" label="conversas na fila" delta="18% esta semana" />
          </Card>
          <Card title="Cartão simples" subtitle="Sem notch">
            <p className="text-ink text-sm">
              Um bloco tonal de 24px de raio, sem borda e sem sombra.
            </p>
          </Card>
          <Card tone="accent" title="Card de destaque" titleSize={18}>
            <Metric value="42" label="fluxos concluídos" onAccent />
          </Card>
          <Card tone="raised" title="Nested / raised" />
        </div>
      </Section>

      <Section title="Accordion">
        <Accordion
          items={[
            {
              id: "a",
              title: "Como funciona a triagem?",
              meta: "Atendimento",
              content: (
                <p className="text-ink text-sm">
                  As conversas chegam na fila de triagem e são distribuídas por prioridade.
                </p>
              ),
            },
            {
              id: "b",
              title: "Posso pausar uma automação?",
              meta: "Automações",
              content: (
                <p className="text-ink text-sm">
                  Sim. O interruptor na tela do fluxo pausa na hora.
                </p>
              ),
            },
          ]}
        />
      </Section>

      <DialogSection />

      <Section title="Steps">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          <Steps
            items={[
              { label: "Conta criada", status: "done" },
              { label: "Conectar um canal", status: "current", href: "#" },
              { label: "Convidar o time", status: "pending" },
              { label: "Criar o primeiro funil", status: "pending" },
              { label: "Receber a primeira conversa", status: "pending" },
            ]}
          />
          <Steps
            items={[
              { label: "Conta criada", status: "done" },
              { label: "Canal conectado", status: "done" },
              { label: "Time convidado", status: "done" },
              { label: "Funil criado", status: "done" },
              { label: "Receber a primeira conversa", status: "current", href: "#" },
            ]}
          />
          <Steps
            items={[
              { label: "Conta criada", status: "done" },
              { label: "Canal conectado", status: "done" },
              { label: "Time convidado", status: "done" },
            ]}
            doneLabel="Espaço pronto."
          />
        </div>
      </Section>

      <Section title="Toast">
        <div className="grid max-w-md grid-cols-1 gap-3">
          <Toast title="Fluxo concluído." description="Todas as etapas foram executadas." />
          <Toast
            tone="danger"
            title="Não foi possível conectar esta ferramenta."
            description="Revise as credenciais e tente novamente."
            onClose={() => undefined}
          />
          <Toast tone="running" title="Sincronizando contatos…" />
        </div>
        <Row>
          <Button
            size="sm"
            onClick={() => toast.success("Fluxo concluído.", { description: "Via toast()." })}
          >
            Disparar toast
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => toast.error("Não foi possível salvar. Tente novamente.")}
          >
            Erro
          </Button>
        </Row>
      </Section>

      <Section title="Tooltip">
        <Row>
          <Tooltip content="Notificações">
            <IconButton icon="bell" label="Notificações" />
          </Tooltip>
          <TooltipBubble tone="accent" placement="top">
            R$ 12,4k
          </TooltipBubble>
          <TooltipBubble tone="default" placement="bottom">
            stem embaixo
          </TooltipBubble>
        </Row>
      </Section>

      <Section title="Mantidos">
        <Row>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button iconRight="chevron-down">Menu</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Ações</DropdownMenuLabel>
              <DropdownMenuItem>Renomear</DropdownMenuItem>
              <DropdownMenuItem>Duplicar</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive">Excluir</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </Row>
      </Section>

      <Templates />
    </>
  );
}
