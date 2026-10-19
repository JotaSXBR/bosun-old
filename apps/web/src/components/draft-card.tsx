"use client";

import { Badge } from "@crm/design-system/components/badge";
import { Button } from "@crm/design-system/components/button";
import { toast } from "@crm/design-system/components/toast";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";

import { publishDraftFill } from "@/lib/draft-bridge";
import { approveDraftAction, rejectDraftAction } from "@/server/actions/drafts";

function useDraftActions(suggestionId: string) {
  const t = useTranslations("drafts");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const approve = () =>
    startTransition(async () => {
      const result = await approveDraftAction({ suggestionId });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(t("approvedToast"));
      router.refresh();
    });

  const reject = () =>
    startTransition(async () => {
      const result = await rejectDraftAction({ suggestionId });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.refresh();
    });
  return { pending, approve, reject };
}

function DraftActions({
  body,
  pending,
  approve,
  reject,
}: {
  body: string;
  pending: boolean;
  approve: () => void;
  reject: () => void;
}) {
  const t = useTranslations("drafts");
  return (
    <div className="flex items-center gap-2 pt-1">
      <Button
        variant="primary"
        size="sm"
        disabled={pending}
        onClick={approve}
        data-testid="draft-approve"
      >
        {t("approve")}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        onClick={() => publishDraftFill(body)}
        data-testid="draft-edit"
      >
        {t("edit")}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={reject}
        data-testid="draft-reject"
      >
        {t("reject")}
      </Button>
    </div>
  );
}

/**
 * Pending AI draft in the conversation thread. Approve sends the body
 * through the channel; Edit drops the text into the composer; Reject
 * dismisses. `stale` = an inbound message arrived after generation —
 * approval is still allowed (human judgment), the badge just warns.
 */
export function DraftCard({
  suggestionId,
  body,
  rationale,
  stale,
}: {
  suggestionId: string;
  body: string;
  rationale: string;
  stale: boolean;
}) {
  const t = useTranslations("drafts");
  const { pending, approve, reject } = useDraftActions(suggestionId);

  return (
    <div
      className="border-signal/40 bg-raised space-y-2 rounded-md border-l-4 p-3"
      data-testid="draft-card"
      data-stale={stale || undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-ink-muted text-xs font-medium uppercase">{t("title")}</span>
        {stale && <Badge tone="warning">{t("staleBadge")}</Badge>}
      </div>
      <p className="text-sm whitespace-pre-wrap">{body}</p>
      <p className="text-ink-muted text-xs italic">{rationale}</p>
      <DraftActions body={body} pending={pending} approve={approve} reject={reject} />
    </div>
  );
}
