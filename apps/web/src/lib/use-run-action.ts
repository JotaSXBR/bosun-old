"use client";

// Shared by the settings islands and ticket actions: runs a server action inside a transition,
// toasts a failure (or the success message) and refreshes the route.
import { toast } from "@crm/design-system/components/toast";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

type ActionResult = { ok: true } | { ok: false; error: string };

export type RunAction = (
  action: Promise<ActionResult>,
  success?: string,
  onSuccess?: () => void,
) => void;

export function useRunAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const run: RunAction = (action, success, onSuccess) =>
    startTransition(async () => {
      const result = await action;
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (success) toast.success(success);
      onSuccess?.();
      router.refresh();
    });
  return { pending, run };
}
