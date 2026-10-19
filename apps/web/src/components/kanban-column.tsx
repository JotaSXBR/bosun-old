"use client";

import type { DealCardRow, StageRow } from "@crm/core/leads";
import { Button } from "@crm/design-system/components/button";
import { cn } from "@crm/design-system/lib/utils";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useTranslations } from "next-intl";

import { SortableDealCard } from "@/components/deal-card";
import { paletteStyle } from "@/components/palette";

export interface CardCallbacks {
  onEdit: (deal: DealCardRow) => void;
  onLabels: (deal: DealCardRow) => void;
  onDelete: (deal: DealCardRow) => void;
  onMove: (deal: DealCardRow, stageId: string) => void;
}

function StageHeader({ stage, count }: { stage: StageRow; count: number }) {
  return (
    <div className="flex items-center justify-between px-1 py-0.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={cn("size-2 shrink-0 rounded-full", paletteStyle(stage.color).dot)} />
        <span className="truncate text-sm font-medium">{stage.name}</span>
        <span className="text-ink-muted text-xs">{count}</span>
      </div>
    </div>
  );
}

function ColumnCards({
  deals,
  stages,
  canWrite,
  canManage,
  cardCallbacks,
}: Pick<ColumnProps, "deals" | "stages" | "canWrite" | "canManage" | "cardCallbacks">) {
  return (
    <SortableContext items={deals.map((d) => d.id)} strategy={verticalListSortingStrategy}>
      <div className="flex min-h-16 flex-col gap-2">
        {deals.map((deal) => (
          <SortableDealCard
            key={deal.id}
            deal={deal}
            stages={stages}
            canWrite={canWrite}
            canManage={canManage}
            {...cardCallbacks}
          />
        ))}
      </div>
    </SortableContext>
  );
}

/** Droppable kanban column: stage header + sortable deal cards + "add deal". */
type ColumnProps = {
  stage: StageRow;
  stages: StageRow[];
  deals: DealCardRow[];
  canWrite: boolean;
  canManage: boolean;
  cardCallbacks: CardCallbacks;
  onAddDeal: () => void;
};

export function KanbanStageColumn({
  stage,
  stages,
  deals,
  canWrite,
  canManage,
  cardCallbacks,
  onAddDeal,
}: ColumnProps) {
  const t = useTranslations("leads");
  const { setNodeRef, isOver } = useDroppable({ id: stage.id, data: { type: "stage" } });
  return (
    <div
      ref={setNodeRef}
      data-testid={`stage-column-${stage.id}`}
      className={cn(
        "bg-raised/40 flex w-64 shrink-0 flex-col gap-2 rounded-lg border p-2",
        isOver && "ring-line-accent ring-2",
      )}
    >
      <StageHeader stage={stage} count={deals.length} />
      <ColumnCards
        deals={deals}
        stages={stages}
        canWrite={canWrite}
        canManage={canManage}
        cardCallbacks={cardCallbacks}
      />
      {canWrite && (
        <Button
          variant="ghost"
          size="sm"
          iconLeft="plus"
          className="text-ink-muted justify-start"
          onClick={onAddDeal}
        >
          {t("addDeal")}
        </Button>
      )}
    </div>
  );
}
