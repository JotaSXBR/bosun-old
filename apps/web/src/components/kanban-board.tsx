"use client";

import type { BoardData, DealCardRow, FunnelRow, LabelRow, StageRow } from "@crm/core/leads";
import { toast } from "@crm/design-system/components/toast";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useState } from "react";

import { DealCardView } from "@/components/deal-card";
import { KanbanStageColumn } from "@/components/kanban-column";
import type { KanbanDialogState } from "@/components/kanban-dialogs";
import { DIALOGS_CLOSED, KanbanDialogs } from "@/components/kanban-dialogs";
import { KanbanToolbar } from "@/components/kanban-toolbar";
import { moveDealAction } from "@/server/actions/leads";

interface ColumnState {
  stage: StageRow;
  deals: DealCardRow[];
}

function toColumns(board: BoardData): ColumnState[] {
  return board.stages.map((s) => ({ stage: s, deals: s.deals }));
}

/** Applies the drop to local columns; returns the persisted target position. */
function applyDrop(columns: ColumnState[], dealId: string, overId: string): number | null {
  const sourceCol = columns.find((c) => c.deals.some((d) => d.id === dealId));
  const targetCol =
    columns.find((c) => c.stage.id === overId) ??
    columns.find((c) => c.deals.some((d) => d.id === overId));
  if (!sourceCol || !targetCol) return null;

  const overIndex = targetCol.deals.findIndex((d) => d.id === overId);
  const toIndex = overIndex === -1 ? targetCol.deals.length : overIndex;
  const fromIndex = sourceCol.deals.findIndex((d) => d.id === dealId);
  const sameColumn = sourceCol.stage.id === targetCol.stage.id;
  if (sameColumn && (fromIndex === toIndex || fromIndex === toIndex - 1)) return null;

  const deal = sourceCol.deals[fromIndex]!;
  const adjusted = sameColumn && fromIndex < toIndex ? toIndex - 1 : toIndex;
  sourceCol.deals.splice(fromIndex, 1);
  targetCol.deals.splice(adjusted, 0, { ...deal, stageId: targetCol.stage.id });
  return adjusted;
}

export function KanbanBoard({
  board,
  funnels,
  labels,
  canWrite,
  canManage,
}: {
  board: BoardData;
  funnels: FunnelRow[];
  labels: LabelRow[];
  canWrite: boolean;
  canManage: boolean;
}) {
  const [columns, setColumns] = useState<ColumnState[]>(() => toColumns(board));
  const [activeDeal, setActiveDeal] = useState<DealCardRow | null>(null);
  const [dialogs, setDialogs] = useState<KanbanDialogState>(DIALOGS_CLOSED);
  const patchDialogs = (patch: Partial<KanbanDialogState>) =>
    setDialogs((prev) => ({ ...prev, ...patch }));

  // Server refresh → resync local columns (adjust-during-render pattern).
  const [prevBoard, setPrevBoard] = useState(board);
  if (prevBoard !== board) {
    setPrevBoard(board);
    setColumns(toColumns(board));
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  function onDragStart(event: DragStartEvent) {
    const id = String(event.active.id);
    setActiveDeal(columns.flatMap((c) => c.deals).find((d) => d.id === id) ?? null);
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveDeal(null);
    const { active, over } = event;
    if (!over || !canWrite) return;
    moveDeal(String(active.id), String(over.id));
  }

  /** Shared move path — drag drop and the card's "Mover para" menu. */
  function moveDeal(dealId: string, overId: string) {
    const targetCol =
      columns.find((c) => c.stage.id === overId) ??
      columns.find((c) => c.deals.some((d) => d.id === overId));
    if (!targetCol) return;

    const previous = columns;
    const next = columns.map((c) => ({ stage: c.stage, deals: [...c.deals] }));
    const position = applyDrop(next, dealId, overId);
    if (position === null) return;
    setColumns(next);

    void moveDealAction({ dealId, stageId: targetCol.stage.id, position }).then((result) => {
      if (!result.ok) {
        setColumns(previous);
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="space-y-4">
      <KanbanToolbar board={board} funnels={funnels} canManage={canManage} />

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div className="flex items-start gap-3 overflow-x-auto pb-4" data-testid="kanban-board">
          {columns.map((column) => (
            <KanbanStageColumn
              key={column.stage.id}
              stage={column.stage}
              stages={columns.map((c) => c.stage)}
              deals={column.deals}
              canWrite={canWrite}
              canManage={canManage}
              cardCallbacks={{
                onEdit: (deal) => patchDialogs({ editingDeal: deal }),
                onLabels: (deal) => patchDialogs({ labelsDeal: deal }),
                onDelete: (deal) => patchDialogs({ deletingDeal: deal }),
                onMove: (deal, stageId) => moveDeal(deal.id, stageId),
              }}
              onAddDeal={() => patchDialogs({ newDealStage: column.stage.id })}
            />
          ))}
        </div>
        <DragOverlay>
          {activeDeal ? (
            <DealCardView
              deal={activeDeal}
              stages={columns.map((c) => c.stage)}
              canWrite={false}
              canManage={false}
              onEdit={() => undefined}
              onLabels={() => undefined}
              onDelete={() => undefined}
              onMove={() => undefined}
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      <KanbanDialogs
        state={dialogs}
        setState={patchDialogs}
        funnelId={board.funnel.id}
        stages={columns.map((c) => c.stage)}
        labels={labels}
        canManage={canManage}
      />
    </div>
  );
}
