"use client";

import type { MacroRow } from "@crm/core/macros";
import { Button } from "@crm/design-system/components/button";
import { Input } from "@crm/design-system/components/input";
import { Textarea } from "@crm/design-system/components/textarea";
import { toast } from "@crm/design-system/components/toast";
import { cn } from "@crm/design-system/lib/utils";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { proposeMacroAction } from "@/server/actions/macros";

/** `/slug` trigger — a slash at token start followed by an in-progress slug. */
export const MACRO_TRIGGER = /(?:^|\s)\/([a-z0-9_-]*)$/i;

type EditorLike = {
  textarea: React.RefObject<HTMLTextAreaElement | null>;
  text: string;
  setText: (text: string) => void;
};

/** `/slug` trigger: the text before the caret ends in a slash-token. */
export function useMacroPicker(macros: MacroRow[], editor: EditorLike) {
  const { textarea, text, setText } = editor;
  const [macroQuery, setMacroQuery] = useState<string | null>(null);
  const [macroActive, setMacroActive] = useState(0);
  const macroMatches =
    macroQuery === null
      ? []
      : macros.filter((m) => m.name.startsWith(macroQuery.toLowerCase())).slice(0, 8);

  const pickMacro = (macro: MacroRow) => {
    const el = textarea.current;
    const caret = el?.selectionStart ?? text.length;
    // Drop the `/partial` token, keep the surrounding whitespace.
    const before = text.slice(0, caret).replace(MACRO_TRIGGER, (s) => s.replace(/\/\S*$/, ""));
    const next = before + macro.content + text.slice(caret);
    setText(next);
    setMacroQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(
        before.length + macro.content.length,
        before.length + macro.content.length,
      );
    });
  };
  return { macroQuery, setMacroQuery, macroActive, setMacroActive, macroMatches, pickMacro };
}

type MacroPickerState = ReturnType<typeof useMacroPicker>;

/** Picker keyboard: Escape closes, arrows move, Enter picks. True when the key was consumed. */
export function handleMacroKey(e: React.KeyboardEvent, picker: MacroPickerState): boolean {
  const matches = picker.macroMatches;
  if (e.key === "Escape") {
    picker.setMacroQuery(null);
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (matches.length > 0) {
      picker.setMacroActive(
        (i) => (i + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length,
      );
    }
  } else if (e.key === "Enter" && matches.length > 0) {
    picker.pickMacro(matches[picker.macroActive] ?? matches[0]!);
  } else {
    return false;
  }
  e.preventDefault();
  return true;
}

type PickerProps = {
  matches: MacroRow[];
  query: string;
  active: number;
  canPropose: boolean;
  onPick: (macro: MacroRow) => void;
  onHover: (index: number) => void;
  onClose: () => void;
};

function MacroList(props: Pick<PickerProps, "matches" | "active" | "onPick" | "onHover">) {
  const { matches, active, onPick, onHover } = props;
  return (
    <ul className="max-h-56 overflow-auto py-1">
      {matches.map((m, i) => (
        <li key={m.id}>
          <button
            type="button"
            className={cn(
              "block w-full px-3 py-1.5 text-left text-sm",
              i === active ? "bg-control" : "hover:bg-control",
            )}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(m)}
          >
            <span className="text-ink-accent font-medium">/{m.name}</span>
            <span className="text-ink-muted ml-2 line-clamp-1 inline text-xs">{m.content}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function useMacroProposal(query: string, onClose: () => void) {
  const t = useTranslations("composer.macros");
  const [proposing, setProposing] = useState(false);
  const [content, setContent] = useState("");
  const [rationale, setRationale] = useState("");
  const [pending, startTransition] = useTransition();

  const propose = () =>
    startTransition(async () => {
      const result = await proposeMacroAction({
        name: query,
        content: content.trim(),
        rationale: rationale.trim(),
      });
      if (!result.ok) return void toast.error(result.error);
      toast.success(t("proposed"));
      onClose();
    });
  return {
    proposing,
    setProposing,
    content,
    setContent,
    rationale,
    setRationale,
    pending,
    propose,
  };
}

type Proposal = ReturnType<typeof useMacroProposal>;

function ProposalForm({ state }: { state: Proposal }) {
  const t = useTranslations("composer.macros");
  const { content, setContent, rationale, setRationale, pending, propose, setProposing } = state;
  return (
    <div className="mt-2 space-y-2">
      <Textarea
        rows={2}
        value={content}
        placeholder={t("contentPlaceholder")}
        onChange={(e) => setContent(e.target.value)}
      />
      <Input
        shape="rounded"
        value={rationale}
        placeholder={t("rationalePlaceholder")}
        onChange={(e) => setRationale(e.target.value)}
      />
      <div className="flex gap-2">
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={pending || !content.trim() || !rationale.trim()}
          onClick={propose}
        >
          {t("sendProposal")}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => setProposing(false)}>
          {t("cancel")}
        </Button>
      </div>
    </div>
  );
}

function EmptyMacros(props: Pick<PickerProps, "query" | "canPropose" | "onClose">) {
  const { query, canPropose, onClose } = props;
  const t = useTranslations("composer.macros");
  const state = useMacroProposal(query, onClose);
  return (
    <div className="p-3 text-sm">
      <p className="text-ink-muted">{t("empty", { query })}</p>
      {canPropose && query.length >= 2 && !state.proposing && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-2"
          onClick={() => state.setProposing(true)}
        >
          {t("propose", { name: query })}
        </Button>
      )}
      {state.proposing && <ProposalForm state={state} />}
    </div>
  );
}

/**
 * `/` quick-reply dropdown anchored above the textarea. Filters org
 * macros by the slug being typed; for agents (no write permission) an
 * empty list offers an inline proposal form.
 */
export function MacroPicker(props: PickerProps) {
  return (
    <div
      className="bg-raised shadow-raised absolute bottom-full left-0 z-10 mb-1 w-80 rounded-md border"
      data-testid="macro-picker"
    >
      {props.matches.length > 0 ? (
        <MacroList {...props} />
      ) : (
        <EmptyMacros query={props.query} canPropose={props.canPropose} onClose={props.onClose} />
      )}
    </div>
  );
}
