"use client";

import type { DealCardRow, StageRow } from "@crm/core/leads";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@crm/design-system/components/dropdown-menu";
import { IconButton } from "@crm/design-system/components/icon-button";
import { cn } from "@crm/design-system/lib/utils";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTranslations } from "next-intl";
import type { CSSProperties } from "react";

import { formatValueCents, paletteStyle } from "@/components/palette";

function MoveToSubmenu({
  deal,
  stages,
  onMove,
}: Pick<DealCardProps, "deal" | "stages" | "onMove">) {
  const t = useTranslations("leads");
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>{t("moveTo")}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {stages
          .filter((s) => s.id !== deal.stageId)
          .map((s) => (
            <DropdownMenuItem key={s.id} onSelect={() => onMove(deal, s.id)}>
              {s.name}
            </DropdownMenuItem>
          ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function DealCardMenu({
  deal,
  stages,
  canWrite,
  canManage,
  onEdit,
  onLabels,
  onDelete,
  onMove,
}: DealCardProps) {
  const t = useTranslations("leads");
  if (!canWrite && !canManage) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          type="button"
          variant="ghost"
          size="sm"
          icon="ellipsis"
          className="size-6 p-0 opacity-0 group-hover:opacity-100 focus:opacity-100"
          label={t("dealActions", { title: deal.title })}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canWrite && <DropdownMenuItem onSelect={() => onEdit(deal)}>{t("edit")}</DropdownMenuItem>}
        {canWrite && <MoveToSubmenu deal={deal} stages={stages} onMove={onMove} />}
        {canWrite && (
          <DropdownMenuItem onSelect={() => onLabels(deal)}>{t("labels")}</DropdownMenuItem>
        )}
        {canManage && (
          <DropdownMenuItem variant="destructive" onSelect={() => onDelete(deal)}>
            {t("delete")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface DealCardProps {
  deal: DealCardRow;
  /** All stages of the board — powers the "Mover para" keyboard fallback. */
  stages: StageRow[];
  canWrite: boolean;
  canManage: boolean;
  onEdit: (deal: DealCardRow) => void;
  onLabels: (deal: DealCardRow) => void;
  onDelete: (deal: DealCardRow) => void;
  onMove: (deal: DealCardRow, stageId: string) => void;
}

type DealCardViewProps = DealCardProps & {
  dragHandleProps?: Record<string, unknown>;
  containerRef?: (el: HTMLElement | null) => void;
  dragging?: boolean;
  style?: CSSProperties;
};

function DealLabelChips({ labels }: { labels: DealCardRow["labels"] }) {
  if (labels.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {labels.map((label) => (
        <span
          key={label.id}
          className={cn(
            "rounded-full px-1.5 py-0.5 text-xs font-medium",
            paletteStyle(label.color).chip,
          )}
        >
          {label.name}
        </span>
      ))}
    </div>
  );
}

export function DealCardView({
  dragHandleProps,
  containerRef,
  dragging,
  style,
  ...card
}: DealCardViewProps) {
  const { deal, canWrite } = card;
  const t = useTranslations("leads");
  return (
    <div
      ref={containerRef}
      style={style}
      data-testid={`deal-card-${deal.id}`}
      className={cn(
        "bg-surface group shadow-control rounded-md border p-3",
        dragging && "shadow-raised opacity-60",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          className={cn(
            "min-w-0 flex-1 cursor-grab text-left active:cursor-grabbing",
            !canWrite && "cursor-default",
          )}
          aria-label={t("dealAria", { title: deal.title })}
          {...(canWrite ? dragHandleProps : {})}
        >
          <p className="truncate text-sm font-medium">{deal.title}</p>
          <p className="text-ink-muted truncate text-xs">{deal.contactName ?? deal.contactRef}</p>
        </button>
        <DealCardMenu {...card} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        {deal.valueCents > 0 ? (
          <span className="text-xs font-medium">{formatValueCents(deal.valueCents)}</span>
        ) : (
          <span />
        )}
      </div>
      <DealLabelChips labels={deal.labels} />
    </div>
  );
}

/** Sortable wrapper used inside a kanban column. */
export function SortableDealCard(props: DealCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.deal.id,
    data: { type: "deal", stageId: props.deal.stageId },
  });
  return (
    <DealCardView
      {...props}
      containerRef={setNodeRef}
      dragging={isDragging}
      dragHandleProps={{ ...attributes, ...listeners }}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    />
  );
}
