import { BarChart } from "../components/bar-chart";
import { Card } from "../components/card";
import { IconButton } from "../components/icon-button";
import { ProgressBar } from "../components/progress-bar";
import { RingChart } from "../components/ring-chart";
import { Section } from "./helpers";

function ProgressDemo() {
  return (
    <>
      <ProgressBar
        value={68}
        label="Meta da semana"
        valueLabel="68%"
        labels={["seg", "ter", "qua", "qui", "sex"]}
      />
      <ProgressBar value={34} tone="warning" thumb label="Capacidade" valueLabel="34%" />
    </>
  );
}

function ExecucoesCard() {
  return (
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
  );
}

function CargaCard() {
  return (
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
  );
}

export function DadosSection() {
  return (
    <Section title="Dados">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <ProgressDemo />
        <ExecucoesCard />
        <CargaCard />
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
