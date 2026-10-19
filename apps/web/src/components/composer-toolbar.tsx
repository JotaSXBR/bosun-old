"use client";

import { Button } from "@crm/design-system/components/button";
import { useTranslations } from "next-intl";

import { EmojiPicker } from "@/components/emoji-picker";

type DraftButtonsProps = {
  disabled: boolean;
  hasText: boolean;
  onRequestDraft: (mode: "suggest" | "improve") => void;
  /** No BYOK credential → draft buttons disabled with an explanatory hint. */
  draftsEnabled: boolean;
  draftsDisabledHint: string;
};

function DraftButtons(props: DraftButtonsProps) {
  const { disabled, hasText, onRequestDraft, draftsEnabled, draftsDisabledHint } = props;
  const t = useTranslations("composer");
  return (
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
        title={draftsEnabled ? (hasText ? undefined : t("draftImproveHint")) : draftsDisabledHint}
        data-testid="draft-improve"
      >
        {t("draftImprove")}
      </Button>
    </>
  );
}

type ToolbarProps = DraftButtonsProps & {
  sendingMedia: boolean;
  /** Attach/voice reach the customer — hidden on the internal-note tab. */
  channelTools: boolean;
  onEmoji: (emoji: string) => void;
  onAttach: () => void;
  recorder: React.ReactNode;
  hint: string;
  attachTitle: string;
};

export function ComposerToolbar(props: ToolbarProps) {
  const { disabled, sendingMedia, channelTools, onEmoji, onAttach, recorder, hint } = props;
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
          title={props.attachTitle}
          data-testid="attach-button"
        >
          📎
        </Button>
      )}
      {channelTools && recorder}
      {channelTools && <DraftButtons {...props} />}
      <span className="text-ink-muted text-xs">{hint}</span>
    </div>
  );
}
