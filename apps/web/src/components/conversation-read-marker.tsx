"use client";

import { useEffect } from "react";

import { markConversationReadAction } from "@/server/actions/messaging";

/**
 * Bumps the viewer's read cursor when the pane mounts — must stay a
 * client component: firing during server render or `<Link>` prefetch
 * would mark threads read that the agent never opened. `lastInboundKey`
 * re-fires the mark when a new inbound lands while the thread is open —
 * that live-read is also the blue-tick trigger (seen = read, not reply).
 */
export function ConversationReadMarker({
  conversationId,
  lastInboundKey,
}: {
  conversationId: string;
  lastInboundKey?: string | null;
}) {
  useEffect(() => {
    markConversationReadAction({ conversationId }).catch(() => undefined);
  }, [conversationId, lastInboundKey]);
  return null;
}
