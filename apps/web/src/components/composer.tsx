"use client";

import type { MacroRow } from "@crm/core/macros";
import { Button } from "@crm/design-system/components/button";
import { Input } from "@crm/design-system/components/input";
import { Textarea } from "@crm/design-system/components/textarea";
import { toast } from "@crm/design-system/components/toast";
import { cn } from "@crm/design-system/lib/utils";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";

import { VoiceRecorder } from "@/components/voice-recorder";
import { useChatPresence } from "@/lib/chat-presence";
import { useDraftFill } from "@/lib/draft-bridge";
import { MAX_UPLOAD_BYTES } from "@/lib/media-upload";
import { setReplyTarget, useReplyTarget } from "@/lib/reply-bridge";
import { sendChannelMessageAction, sendMediaMessageAction } from "@/server/actions/chat";
import { requestDraftAction } from "@/server/actions/drafts";
import { proposeMacroAction } from "@/server/actions/macros";
import { addInternalNoteAction } from "@/server/actions/messaging";

type Mode = "reply" | "note";

/** `/slug` trigger — a slash at token start followed by an in-progress slug. */
const MACRO_TRIGGER = /(?:^|\s)\/([a-z0-9_-]*)$/i;

// Common emoji set — no dependency; the OS renders glyphs natively.
const EMOJIS = (
  "😀 😄 😁 😂 🤣 😊 😍 😘 😎 🤔 😅 😢 😭 😡 👍 👎 🙏 👏 💪 🤝 ✅ ❌ " +
  "❤️ 💔 🔥 ✨ 🎉 🎂 ⚽ 🚀 💡 📌 📎 🕐 ☀️ 🌙 ⭐ 💬 📞 📷 🎵 🔒 💰"
).split(" ");

function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const t = useTranslations("composer");
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={t("emojisTitle")}
        data-testid="emoji-button"
      >
        😊
      </Button>
      {open && (
        <div
          className="bg-raised shadow-raised absolute bottom-full left-0 z-10 mb-1 grid w-64 grid-cols-8 gap-0.5 rounded-md border p-1"
          data-testid="emoji-grid"
        >
          {EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="hover:bg-raised rounded-xs p-1 text-lg"
              onClick={() => {
                onPick(emoji);
                setOpen(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

function ComposerToolbar({
  disabled,
  sendingMedia,
  channelTools,
  hasText,
  onEmoji,
  onAttach,
  onRequestDraft,
  draftsEnabled,
  draftsDisabledHint,
  recorder,
  hint,
  attachTitle,
}: {
  attachTitle: string;
  disabled: boolean;
  sendingMedia: boolean;
  /** Attach/voice reach the customer — hidden on the internal-note tab. */
  channelTools: boolean;
  hasText: boolean;
  onEmoji: (emoji: string) => void;
  onAttach: () => void;
  onRequestDraft: (mode: "suggest" | "improve") => void;
  /** No BYOK credential → draft buttons disabled with an explanatory hint. */
  draftsEnabled: boolean;
  draftsDisabledHint: string;
  recorder: React.ReactNode;
  hint: string;
}) {
  const t = useTranslations("composer");
  return (
    <div className="flex items-center gap-1">
      <EmojiPicker onPick={onEmoji} />
      {channelTools && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || sendingMedia}
          onClick={onAttach}
          title={attachTitle}
          data-testid="attach-button"
        >
          📎
        </Button>
      )}
      {channelTools && recorder}
      {channelTools && (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || !draftsEnabled}
            onClick={() => onRequestDraft("suggest")}
            title={draftsEnabled ? undefined : draftsDisabledHint}
            data-testid="draft-suggest"
          >
            {t("draftSuggest")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || !draftsEnabled || !hasText}
            onClick={() => onRequestDraft("improve")}
            title={
              draftsEnabled ? (hasText ? undefined : t("draftImproveHint")) : draftsDisabledHint
            }
            data-testid="draft-improve"
          >
            {t("draftImprove")}
          </Button>
        </>
      )}
      <span className="text-ink-muted text-xs">{hint}</span>
    </div>
  );
}

function ModeTabs({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const t = useTranslations("composer");
  const MODES = [
    { key: "reply", label: t("tabReply") },
    { key: "note", label: t("tabNote") },
  ] as const;
  return (
    <div className="flex gap-1" role="tablist" aria-label={t("tabsAria")}>
      {MODES.map((m) => (
        <button
          key={m.key}
          type="button"
          role="tab"
          aria-selected={mode === m.key}
          onClick={() => onChange(m.key)}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            mode === m.key
              ? m.key === "note"
                ? "bg-warning/15 text-warning"
                : "bg-signal text-ink-on-signal"
              : "text-ink-muted hover:text-ink",
          )}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

/**
 * `/` quick-reply dropdown anchored above the textarea. Filters org
 * macros by the slug being typed; for agents (no write permission) an
 * empty list offers an inline proposal form.
 */
function MacroPicker({
  matches,
  query,
  active,
  canPropose,
  onPick,
  onHover,
  onClose,
}: {
  matches: MacroRow[];
  query: string;
  active: number;
  canPropose: boolean;
  onPick: (macro: MacroRow) => void;
  onHover: (index: number) => void;
  onClose: () => void;
}) {
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

  return (
    <div
      className="bg-raised shadow-raised absolute bottom-full left-0 z-10 mb-1 w-80 rounded-md border"
      data-testid="macro-picker"
    >
      {matches.length > 0 ? (
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
      ) : (
        <div className="p-3 text-sm">
          <p className="text-ink-muted">{t("empty", { query })}</p>
          {canPropose && query.length >= 2 && !proposing && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-2"
              onClick={() => setProposing(true)}
            >
              {t("propose", { name: query })}
            </Button>
          )}
          {proposing && (
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
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setProposing(false)}
                >
                  {t("cancel")}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReplyChip({ preview, onClear }: { preview: string; onClear: () => void }) {
  const t = useTranslations("composer");
  return (
    <div
      className="bg-raised border-l-success flex items-center justify-between rounded-md border-l-4 px-3 py-1.5 text-xs"
      data-testid="reply-preview"
    >
      <span className="line-clamp-1 italic opacity-80">↩ {preview}</span>
      <button
        type="button"
        className="text-ink-muted hover:text-ink px-1"
        onClick={onClear}
        aria-label={t("cancelReply")}
      >
        ✕
      </button>
    </div>
  );
}

/** Message text plus caret-aware emoji insertion. */
function useComposerText() {
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const [text, setText] = useState("");

  const insertEmoji = (emoji: string) => {
    const el = textarea.current;
    if (!el) {
      setText((t) => t + emoji);
      return;
    }
    const at = el.selectionStart;
    const next = text.slice(0, at) + emoji + text.slice(el.selectionEnd);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at + emoji.length, at + emoji.length);
    });
  };
  return { textarea, text, setText, insertEmoji };
}

type TextEditor = ReturnType<typeof useComposerText>;

/** `/slug` trigger: the text before the caret ends in a slash-token. */
function useMacroPicker(
  macros: MacroRow[],
  editor: Pick<TextEditor, "textarea" | "text" | "setText">,
) {
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

type MacroPicker = ReturnType<typeof useMacroPicker>;

/** Picker keyboard: Escape closes, arrows move, Enter picks. True when the key was consumed. */
function handleMacroKey(e: React.KeyboardEvent, picker: MacroPicker): boolean {
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

/** Upload body for an attachment; the typed text becomes its caption. */
function mediaForm(args: {
  conversationId: string;
  file: File;
  caption: string;
  replyToId?: string;
}) {
  const form = new FormData();
  form.set("conversationId", args.conversationId);
  form.set("file", args.file);
  if (args.caption) form.set("caption", args.caption);
  if (args.replyToId) form.set("replyToId", args.replyToId);
  return form;
}

/** Send / draft / attach actions of the composer and their pending flags. */
function useComposerActions(args: {
  conversationId: string;
  mode: Mode;
  text: string;
  setText: (text: string) => void;
  replyTo: ReturnType<typeof useReplyTarget>;
  presence: ReturnType<typeof useChatPresence>;
}) {
  const { conversationId, mode, text, setText, replyTo, presence } = args;
  const t = useTranslations("composer");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [sendingMedia, setSendingMedia] = useState(false);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const replyToId = replyTo?.externalId;
    presence.pause();
    startTransition(async () => {
      const result =
        mode === "reply"
          ? await sendChannelMessageAction({
              conversationId,
              content: { type: "text", text: trimmed },
              ...(replyToId ? { replyToId } : {}),
            })
          : await addInternalNoteAction({ conversationId, text: trimmed });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setText("");
      setReplyTarget(null);
      router.refresh();
    });
  };

  /** Async drafter call — the card lands via SSE refresh; toast just confirms enqueue. */
  const requestDraft = (draftMode: "suggest" | "improve") =>
    startTransition(async () => {
      const result = await requestDraftAction({
        conversationId,
        mode: draftMode,
        ...(draftMode === "improve" ? { sourceText: text.trim() } : {}),
      });
      if (!result.ok) return void toast.error(result.error);
      toast.info(t("draftRequested"));
    });

  const sendFile = (file: File) => {
    // The action body is capped at 65 MB — reject oversized files here so
    // the composer never sits on "Enviando arquivo…" for a doomed upload.
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error(t("uploadTooLarge"));
      return;
    }
    setSendingMedia(true);
    const form = mediaForm({
      conversationId,
      file,
      caption: text.trim(),
      ...(replyTo ? { replyToId: replyTo.externalId } : {}),
    });
    void sendMediaMessageAction(form)
      .then((result) => {
        setSendingMedia(false);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        setText("");
        setReplyTarget(null);
        router.refresh();
      })
      .catch(() => {
        // Transport-level rejection (e.g. body over the Next limit) never
        // reaches the action — reset and toast or the composer stays stuck.
        setSendingMedia(false);
        toast.error(t("uploadFailed"));
      });
  };

  return { pending, sendingMedia, send, requestDraft, sendFile };
}

export function Composer({
  conversationId,
  disabled,
  draftsEnabled,
  macros,
  canProposeMacro,
}: {
  conversationId: string;
  disabled: boolean;
  /** No org LLM credential → the draft buttons sit disabled with a hint. */
  draftsEnabled: boolean;
  /** Org quick replies for the `/` picker (empty when none). */
  macros: MacroRow[];
  /** Agent path — no direct write, only the proposal affordance. */
  canProposeMacro: boolean;
}) {
  const t = useTranslations("composer");
  const [mode, setMode] = useState<Mode>("reply");
  const fileInput = useRef<HTMLInputElement | null>(null);
  const replyTo = useReplyTarget();
  const { textarea, text, setText, insertEmoji } = useComposerText();
  const picker = useMacroPicker(macros, { textarea, text, setText });
  // "Editar" on a draft card publishes the body here.
  useDraftFill((body) => {
    setText(body);
    setMode("reply");
    textarea.current?.focus();
  });
  // Presence only flows on the reply tab — internal notes never reach the remote.
  const presence = useChatPresence(conversationId, !disabled && mode === "reply");
  const { pending, sendingMedia, send, requestDraft, sendFile } = useComposerActions({
    conversationId,
    mode,
    text,
    setText,
    replyTo,
    presence,
  });

  return (
    <div className="space-y-2 border-t pt-4" data-testid="composer">
      <ModeTabs mode={mode} onChange={setMode} />

      {replyTo && <ReplyChip preview={replyTo.preview} onClear={() => setReplyTarget(null)} />}

      <div className="relative">
        {picker.macroQuery !== null && (
          <MacroPicker
            matches={picker.macroMatches}
            query={picker.macroQuery}
            active={picker.macroActive}
            canPropose={canProposeMacro}
            onPick={picker.pickMacro}
            onHover={picker.setMacroActive}
            onClose={() => picker.setMacroQuery(null)}
          />
        )}
        <Textarea
          ref={textarea}
          value={text}
          onChange={(e) => {
            const next = e.target.value;
            setText(next);
            if (mode === "reply") presence.signal("typing");
            const caret = e.target.selectionStart;
            const trigger = MACRO_TRIGGER.exec(next.slice(0, caret));
            picker.setMacroQuery(trigger ? (trigger[1] ?? "").toLowerCase() : null);
            picker.setMacroActive(0);
          }}
          placeholder={
            disabled
              ? t("placeholderDisabled")
              : mode === "reply"
                ? t("placeholderReply")
                : t("placeholderNote")
          }
          disabled={disabled || pending}
          rows={3}
          onKeyDown={(e) => {
            if (picker.macroQuery !== null && handleMacroKey(e, picker)) return;
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") send();
          }}
        />
      </div>

      <input
        ref={fileInput}
        type="file"
        className="hidden"
        aria-label={t("attach")}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) sendFile(file);
        }}
      />

      <div className="flex items-center justify-between gap-2">
        <ComposerToolbar
          disabled={disabled || pending}
          sendingMedia={sendingMedia}
          channelTools={mode === "reply"}
          hasText={text.trim().length > 0}
          onEmoji={insertEmoji}
          onAttach={() => fileInput.current?.click()}
          onRequestDraft={requestDraft}
          draftsEnabled={draftsEnabled}
          draftsDisabledHint={t("draftNoCredential")}
          attachTitle={t("attach")}
          recorder={
            <VoiceRecorder
              conversationId={conversationId}
              disabled={disabled}
              presence={presence}
            />
          }
          hint={sendingMedia ? t("hintSendingMedia") : t("hintSend")}
        />
        <Button variant="primary" onClick={send} disabled={disabled || pending || !text.trim()}>
          {pending ? t("sending") : mode === "reply" ? t("send") : t("addNote")}
        </Button>
      </div>
    </div>
  );
}
