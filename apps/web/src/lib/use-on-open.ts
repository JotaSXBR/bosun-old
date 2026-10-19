"use client";

import { useState } from "react";

/** Runs `onOpen` each time a dialog opens (adjust-during-render, no effect). */
export function useOnOpen(open: boolean, onOpen: () => void) {
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) onOpen();
  }
}
