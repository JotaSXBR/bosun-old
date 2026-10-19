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

const findTargetColumn = (columns: ColumnState[], overId: string) =>
  columns.find((c) => c.stage.id === overId) ??
  columns.find((c) => c.deals.some((d) => d.id === overId));

/** Where the deal leaves from and lands in (after the removal shift); null for a no-op drop. */
function planMove(
  { sourceCol, targetCol }: { sourceCol: ColumnState; targetCol: ColumnState },
  { dealId, overId }: { dealId: string; overId: string },
): { fromIndex: number; adjusted: number } | null {
  const overIndex = targetCol.deals.findIndex((d) => d.id === overId);
  const toIndex = overIndex === -1 ? targetCol.deals.length : overIndex;
  const fromIndex = sourceCol.deals.findIndex((d) => d.id === dealId);
  const sameColumn = sourceCol.stage.id === targetCol.stage.id;
  if (sameColumn && (fromIndex === toIndex || fromIndex === toIndex - 1)) return null;
  const adjusted = sameColumn && fromIndex < toIndex ? toIndex - 1 : toIndex;
  return { fromIndex, adjusted };
}

/** Applies the drop to local columns; returns the persisted target position. */
function applyDrop(columns: ColumnState[], dealId: string, overId: string): number | null {
  const sourceCol = columns.find((c) => c.deals.some((d) => d.id === dealId));
  const targetCol = findTargetColumn(columns, overId);
  if (!sourceCol || !targetCol) return null;

  const move = planMove({ sourceCol, targetCol }, { dealId, overId });
  if (!move) return null;
  const [deal] = sourceCol.deals.splice(move.fromIndex, 1);
  targetCol.deals.splice(move.adjusted, 0, { ...deal!, stageId: targetCol.stage.id });
  return move.adjusted;
}

/** Local copy of the columns (optimistic drag); a server refresh replaces it — adjust-during-render. */
function useBoardColumns(board: BoardData) {
  const [columns, setColumns] = useState<ColumnState[]>(() => toColumns(board));
  const [prevBoard, setPrevBoard] = useState(board);
  if (prevBoard !== board) {
    setPrevBoard(board);
    setColumns(toColumns(board));
  }
  return [columns, setColumns] as const;
}

type SetColumns = (columns: ColumnState[]) => void;

/** Drag state and the shared move path — drag drop and the card's "Mover para" menu. */
function useKanbanDrag({
  columns,
  setColumns,
  canWrite,
}: {
  columns: ColumnState[];
  setColumns: SetColumns;
  canWrite: boolean;
}) {
  const [activeDeal, setActiveDeal] = useState<DealCardRow | null>(null);

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

  function moveDeal(dealId: string, overId: string) {
    const targetCol = findTargetColumn(columns, overId);
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
  return { activeDeal, onDragStart, onDragEnd, moveDeal };
}

function KanbanColumns({
  columns,
  canWrite,
  canManage,
  patchDialogs,
  moveDeal,
}: {
  columns: ColumnState[];
  canWrite: boolean;
  canManage: boolean;
  patchDialogs: (patch: Partial<KanbanDialogState>) => void;
  moveDeal: (dealId: string, overId: string) => void;
}) {
  return (
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
  );
}

const useKanbanSensors = () =>
  useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

/** Read-only card that follows the pointer while dragging. */
function DragPreview({ deal, stages }: { deal: DealCardRow; stages: StageRow[] }) {
  return (
    <DealCardView
      deal={deal}
      stages={stages}
      canWrite={false}
      canManage={false}
      onEdit={() => undefined}
      onLabels={() => undefined}
      onDelete={() => undefined}
      onMove={() => undefined}
    />
  );
}

type KanbanBoardProps = {
  board: BoardData;
  funnels: FunnelRow[];
  labels: LabelRow[];
  canWrite: boolean;
  canManage: boolean;
};

export function KanbanBoard({ board, funnels, labels, canWrite, canManage }: KanbanBoardProps) {
  const [columns, setColumns] = useBoardColumns(board);
  const [dialogs, setDialogs] = useState<KanbanDialogState>(DIALOGS_CLOSED);
  const patchDialogs = (patch: Partial<KanbanDialogState>) =>
    setDialogs((prev) => ({ ...prev, ...patch }));
  const { activeDeal, onDragStart, onDragEnd, moveDeal } = useKanbanDrag({
    columns,
    setColumns,
    canWrite,
  });
  const stages = columns.map((c) => c.stage);
  const sensors = useKanbanSensors();

  return (
    <div className="space-y-4">
      <KanbanToolbar board={board} funnels={funnels} canManage={canManage} />

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <KanbanColumns
          columns={columns}
          canWrite={canWrite}
          canManage={canManage}
          patchDialogs={patchDialogs}
          moveDeal={moveDeal}
        />
        <DragOverlay>{activeDeal && <DragPreview deal={activeDeal} stages={stages} />}</DragOverlay>
      </DndContext>

      <KanbanDialogs
        state={dialogs}
        setState={patchDialogs}
        funnelId={board.funnel.id}
        stages={stages}
        labels={labels}
        canManage={canManage}
      />
    </div>
  );
}
