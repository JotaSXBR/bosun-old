"use client";

import type { MacroRow } from "@crm/core/macros";
import { Button } from "@crm/design-system/components/button";
import { Textarea } from "@crm/design-system/components/textarea";
import { toast } from "@crm/design-system/components/toast";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";

import { type Mode, ModeTabs, ReplyChip } from "@/components/composer-chrome";
import { ComposerToolbar } from "@/components/composer-toolbar";
import {
  handleMacroKey,
  MACRO_TRIGGER,
  MacroPicker,
  useMacroPicker,
} from "@/components/macro-picker";
import { VoiceRecorder } from "@/components/voice-recorder";
import { useChatPresence } from "@/lib/chat-presence";
import { useDraftFill } from "@/lib/draft-bridge";
import { MAX_UPLOAD_BYTES } from "@/lib/media-upload";
import { setReplyTarget, useReplyTarget } from "@/lib/reply-bridge";
import { sendChannelMessageAction, sendMediaMessageAction } from "@/server/actions/chat";
import { requestDraftAction } from "@/server/actions/drafts";
import { addInternalNoteAction } from "@/server/actions/messaging";

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

/** Send / draft actions and their pending flag (reply and internal-note modes). */
function useSendActions(args: {
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

  return { pending, send, requestDraft };
}

/** Attachment upload: the typed text becomes the caption, the reply target carries over. */
function useSendFile(args: {
  conversationId: string;
  text: string;
  setText: (text: string) => void;
  replyTo: ReturnType<typeof useReplyTarget>;
}) {
  const { conversationId, text, setText, replyTo } = args;
  const t = useTranslations("composer");
  const router = useRouter();
  const [sendingMedia, setSendingMedia] = useState(false);

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
  return { sendingMedia, sendFile };
}

type ComposerProps = {
  conversationId: string;
  disabled: boolean;
  /** No org LLM credential → the draft buttons sit disabled with a hint. */
  draftsEnabled: boolean;
  /** Org quick replies for the `/` picker (empty when none). */
  macros: MacroRow[];
  /** Agent path — no direct write, only the proposal affordance. */
  canProposeMacro: boolean;
};

/** Everything the composer renders from: text, mode, reply target, picker and actions. */
function useComposer({ conversationId, disabled, macros }: ComposerProps) {
  const [mode, setMode] = useState<Mode>("reply");
  const replyTo = useReplyTarget();
  const editor = useComposerText();
  const picker = useMacroPicker(macros, editor);
  // "Editar" on a draft card publishes the body here.
  useDraftFill((body) => {
    editor.setText(body);
    setMode("reply");
    editor.textarea.current?.focus();
  });
  // Presence only flows on the reply tab — internal notes never reach the remote.
  const presence = useChatPresence(conversationId, !disabled && mode === "reply");
  const sendArgs = { conversationId, text: editor.text, setText: editor.setText, replyTo };
  const sending = useSendActions({ ...sendArgs, mode, presence });
  const file = useSendFile(sendArgs);
  return { mode, setMode, replyTo, editor, picker, presence, ...sending, ...file };
}

type ComposerState = ReturnType<typeof useComposer>;

function ComposerInput({ state, disabled }: { state: ComposerState; disabled: boolean }) {
  const t = useTranslations("composer");
  const { mode, editor, picker, presence, pending, send } = state;
  const { textarea, text, setText } = editor;
  const placeholder = disabled
    ? t("placeholderDisabled")
    : mode === "reply"
      ? t("placeholderReply")
      : t("placeholderNote");
  return (
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
      placeholder={placeholder}
      disabled={disabled || pending}
      rows={3}
      onKeyDown={(e) => {
        if (picker.macroQuery !== null && handleMacroKey(e, picker)) return;
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") send();
      }}
    />
  );
}

function ComposerFooter(props: ComposerProps & { state: ComposerState }) {
  const { conversationId, disabled, draftsEnabled, state } = props;
  const t = useTranslations("composer");
  const fileInput = useRef<HTMLInputElement | null>(null);
  const { mode, editor, presence, pending, sendingMedia, send, requestDraft, sendFile } = state;
  const hasText = editor.text.trim().length > 0;
  return (
    <>
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
          hasText={hasText}
          onEmoji={editor.insertEmoji}
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
        <Button variant="primary" onClick={send} disabled={disabled || pending || !hasText}>
          {pending ? t("sending") : mode === "reply" ? t("send") : t("addNote")}
        </Button>
      </div>
    </>
  );
}

export function Composer(props: ComposerProps) {
  const state = useComposer(props);
  const { replyTo, picker } = state;

  return (
    <div className="space-y-2 border-t pt-4" data-testid="composer">
      <ModeTabs mode={state.mode} onChange={state.setMode} />

      {replyTo && <ReplyChip preview={replyTo.preview} onClear={() => setReplyTarget(null)} />}

      <div className="relative">
        {picker.macroQuery !== null && (
          <MacroPicker
            matches={picker.macroMatches}
            query={picker.macroQuery}
            active={picker.macroActive}
            canPropose={props.canProposeMacro}
            onPick={picker.pickMacro}
            onHover={picker.setMacroActive}
            onClose={() => picker.setMacroQuery(null)}
          />
        )}
        <ComposerInput state={state} disabled={props.disabled} />
      </div>

      <ComposerFooter {...props} state={state} />
    </div>
  );
}
